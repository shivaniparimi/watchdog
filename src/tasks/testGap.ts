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
import { fetchHeadContents, type TaskContext, type TaskResult } from "./context.js";

export interface TestGapOptions {
  failOn: Config["failOn"];
  maxFunctions: number;
  /** Break changed lines on purpose and run the tests (needs the project's dependencies installed). */
  mutationTesting: boolean;
  maxMutants: number;
  mutationBudgetMs: number;
  testTimeoutMs: number;
}

export function parseFailOn(value: string): Config["failOn"] {
  if (!["none", "high", "medium", "low"].includes(value)) {
    throw new Error(`fail-on must be none, high, medium or low (got "${value}")`);
  }
  return value as Config["failOn"];
}

export async function runTestGap(ctx: TaskContext, options: TestGapOptions): Promise<TaskResult> {
  const config: Config = { failOn: options.failOn, maxFunctions: options.maxFunctions, ignorePaths: ctx.ignorePaths };

  // Changed source files are read at the exact PR head so line numbers match the diff.
  const sources = ctx.files
    .filter((f) => f.status !== "removed" && classifyFile(f.path, config.ignorePaths) === "source")
    .map((f) => f.path);
  const repo = fsRepo(ctx.repoRoot, await fetchHeadContents(ctx, sources));

  let judgeFn: Judge | undefined;
  if (ctx.ai) {
    const provider = ctx.ai;
    judgeFn = (symbols) => judge(symbols, { provider, repoRoot: ctx.repoRoot });
  } else {
    ctx.log.warning("No AI key given (gemini-api-key or anthropic-api-key); running test-gap rule checks only.");
  }

  const result = await findTestGaps(ctx.files, repo, config, judgeFn);

  // Mutation check: break changed lines on purpose and see whether any test notices. No AI needed.
  let summary = summaryMarkdown(result);
  const comments = inlineComments(result);
  if (options.mutationTesting) {
    const runners = detectRunners(ctx.repoRoot);
    if (runners.size === 0) {
      ctx.log.info("Skipping the mutation check: no Vitest, Jest or pytest install found.");
    } else {
      const report = await runMutations(ctx.files, {
        root: ctx.repoRoot,
        repo,
        runners,
        ignorePaths: config.ignorePaths,
        maxMutants: options.maxMutants,
        budgetMs: options.mutationBudgetMs,
        testTimeoutMs: options.testTimeoutMs,
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

  const gaps = result.findings.filter((f) => isGap(f) && !f.verdict.uncertain).length;
  ctx.log.info(
    `Checked ${result.findings.length} function(s): ${gaps} gap(s), ${onPr.size} inline comment(s) on the PR.`,
  );
  return {
    summary,
    outputs: { gaps },
    failure: shouldFail(result, config.failOn)
      ? `Found untested changes at or above "${config.failOn}" risk.`
      : undefined,
  };
}
