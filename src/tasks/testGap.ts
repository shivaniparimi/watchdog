import * as core from "@actions/core";
import { classifyFile } from "../classify.js";
import { postInlineComments, upsertSummary } from "../github.js";
import { judge } from "../judge.js";
import { findTestGaps, isGap, type Judge } from "../pipeline.js";
import { fsRepo } from "../repo.js";
import { inlineComments, shouldFail, SUMMARY_MARKER, summaryMarkdown } from "../report.js";
import type { Config } from "../types.js";
import { fetchHeadContents, type TaskContext } from "./context.js";

export async function runTestGap(ctx: TaskContext): Promise<void> {
  const failOn = core.getInput("fail-on") || "none";
  if (!["none", "high", "medium", "low"].includes(failOn)) {
    throw new Error(`fail-on must be none, high, medium or low (got "${failOn}")`);
  }
  const config: Config = {
    failOn: failOn as Config["failOn"],
    maxFunctions: Number(core.getInput("max-functions") || 40),
    ignorePaths: ctx.ignorePaths,
  };

  // Changed source files are read at the exact PR head so line numbers match the diff.
  const sources = ctx.files
    .filter((f) => f.status !== "removed" && classifyFile(f.path, config.ignorePaths) === "source")
    .map((f) => f.path);
  const repo = fsRepo(process.env.GITHUB_WORKSPACE ?? process.cwd(), await fetchHeadContents(ctx, sources));

  let judgeFn: Judge | undefined;
  if (ctx.anthropic) {
    const client = ctx.anthropic;
    const repoRoot = process.env.GITHUB_WORKSPACE ?? process.cwd();
    judgeFn = (symbols) => judge(symbols, { client, model: ctx.model, repoRoot });
  } else {
    core.warning("No anthropic-api-key given; running test-gap rule checks only.");
  }

  const result = await findTestGaps(ctx.files, repo, config, judgeFn);
  const summary = summaryMarkdown(result);

  const onPr = await postInlineComments(ctx.octokit, ctx.pr, inlineComments(result), {
    reviewBody: (n) =>
      `🧪 Test gap finder: ${n} changed function(s) look untested. See the summary comment for the full list.`,
    isPosted: (c, bodies) => bodies.some((b) => b.includes(c.key)),
  });
  await upsertSummary(ctx.octokit, ctx.pr, SUMMARY_MARKER, summary);
  await core.summary.addRaw(summary).write();

  const gaps = result.findings.filter((f) => isGap(f) && !f.verdict.uncertain).length;
  core.setOutput("gaps", gaps);
  core.info(`Checked ${result.findings.length} function(s): ${gaps} gap(s), ${onPr.size} inline comment(s) on the PR.`);
  if (shouldFail(result, config.failOn)) core.setFailed(`Found untested changes at or above "${config.failOn}" risk.`);
}
