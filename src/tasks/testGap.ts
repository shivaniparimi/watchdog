import * as core from "@actions/core";
import { classifyFile } from "../classify.js";
import { postInlineComments, upsertSummary } from "../github.js";
import { judge } from "../judge.js";
import { findTestGaps, isGap, type Judge } from "../pipeline.js";
import { fsRepo } from "../repo.js";
import { inlineComments, shouldFail, SUMMARY_MARKER, summaryMarkdown } from "../report.js";
import type { Config } from "../types.js";
import { runMutations } from "../verify/mutate.js";
import { applyMutations, mutationComments, mutationMarkdown } from "../verify/mutationReport.js";
import { detectRunners } from "../verify/runner.js";
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
  const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const repo = fsRepo(root, await fetchHeadContents(ctx, sources));

  let judgeFn: Judge | undefined;
  if (ctx.ai) {
    const provider = ctx.ai;
    judgeFn = (symbols) => judge(symbols, { provider, repoRoot: root });
  } else {
    core.warning("No AI key given (gemini-api-key or anthropic-api-key); running test-gap rule checks only.");
  }

  const result = await findTestGaps(ctx.files, repo, config, judgeFn);

  // Mutation check: break changed lines on purpose and see whether any test notices. No AI needed.
  let summary = summaryMarkdown(result);
  const comments = inlineComments(result);
  if (core.getBooleanInput("mutation-testing")) {
    const runners = detectRunners(root);
    if (runners.size === 0) {
      core.info("Skipping the mutation check: no Vitest, Jest or pytest install found.");
    } else {
      const report = await runMutations(ctx.files, {
        root,
        repo,
        runners,
        ignorePaths: config.ignorePaths,
        maxMutants: Number(core.getInput("max-mutants") || 30),
        budgetMs: Number(core.getInput("mutation-budget") || 600) * 1000,
        testTimeoutMs: Number(core.getInput("test-timeout") || 120) * 1000,
      });
      applyMutations(result, report);
      summary = summaryMarkdown(result) + "\n" + mutationMarkdown(report);
      comments.splice(0, comments.length, ...inlineComments(result), ...mutationComments(report));
    }
  }

  const onPr = await postInlineComments(ctx.octokit, ctx.pr, comments, {
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
