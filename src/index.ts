import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import Anthropic from "@anthropic-ai/sdk";
import { classifyFile } from "./classify.js";
import { fetchFileAtHead, listPrFiles, postInlineComments, upsertSummary, type PrRef } from "./github.js";
import { DEFAULT_MODEL, judge } from "./judge.js";
import { findTestGaps, isGap, type Judge } from "./pipeline.js";
import { fsRepo } from "./repo.js";
import { inlineComments, shouldFail, summaryMarkdown } from "./report.js";
import type { Config } from "./types.js";

function readConfig(): Config {
  const failOn = core.getInput("fail-on") || "none";
  if (!["none", "high", "medium", "low"].includes(failOn)) {
    throw new Error(`fail-on must be none, high, medium or low (got "${failOn}")`);
  }
  return {
    failOn: failOn as Config["failOn"],
    maxFunctions: Number(core.getInput("max-functions") || 40),
    ignorePaths: core
      .getInput("ignore-paths")
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

async function run(): Promise<void> {
  const pull = context.payload.pull_request;
  if (!pull) {
    core.info("Not a pull_request event; nothing to check.");
    return;
  }

  const config = readConfig();
  const octokit = getOctokit(core.getInput("github-token", { required: true }));
  const pr: PrRef = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pullNumber: pull.number,
    headSha: pull.head.sha,
  };

  const files = await listPrFiles(octokit, pr);

  // Read changed source files at the exact PR head so line numbers match the diff.
  const overrides = new Map<string, string>();
  for (const f of files) {
    if (f.status === "removed" || classifyFile(f.path, config.ignorePaths) !== "source") continue;
    const content = await fetchFileAtHead(octokit, pr, f.path);
    if (content !== null) overrides.set(f.path, content);
  }
  const repo = fsRepo(process.env.GITHUB_WORKSPACE ?? process.cwd(), overrides);

  const apiKey = core.getInput("anthropic-api-key");
  const model = core.getInput("model") || DEFAULT_MODEL;
  let judgeFn: Judge | undefined;
  if (apiKey) {
    core.setSecret(apiKey);
    const client = new Anthropic({ apiKey });
    judgeFn = (symbols) => judge(symbols, { client, model });
  } else {
    core.warning("No anthropic-api-key given; running rule checks only.");
  }

  const result = await findTestGaps(files, repo, config, judgeFn);
  const summary = summaryMarkdown(result);
  const comments = inlineComments(result);

  const posted = await postInlineComments(octokit, pr, comments);
  await upsertSummary(octokit, pr, summary);
  await core.summary.addRaw(summary).write();

  const gaps = result.findings.filter((f) => isGap(f) && !f.verdict.uncertain).length;
  core.setOutput("gaps", gaps);
  core.info(`Checked ${result.findings.length} function(s): ${gaps} gap(s), ${posted} new inline comment(s).`);

  if (shouldFail(result, config.failOn)) {
    core.setFailed(`Found untested changes at or above "${config.failOn}" risk.`);
  }
}

run().catch((err) => core.setFailed(err instanceof Error ? err.message : String(err)));
