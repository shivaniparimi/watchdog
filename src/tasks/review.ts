import { AiQuotaError } from "../ai/index.js";
import { postInlineComments, upsertSummary } from "../github.js";
import { fsRepo } from "../repo.js";
import { collectReviewFiles } from "../review/collect.js";
import {
  REVIEW_SUMMARY_MARKER,
  isDuplicate,
  reviewComments,
  reviewSummaryMarkdown,
  validateFindings,
} from "../review/report.js";
import { reviewPr, SEVERITIES, summarize, type Severity } from "../review/review.js";
import { proveFindings } from "../verify/prove.js";
import { detectRunners } from "../verify/runner.js";
import { fetchHeadContents, type TaskContext, type TaskResult } from "./context.js";

export interface ReviewOptions {
  minSeverity: Severity | "none";
  failOnSeverity: Severity | "none";
  maxComments: number;
  /** Prompt budget; defaults to the provider's. */
  maxChars?: number;
  /** Exploration round trips; defaults to the provider's. */
  maxIterations?: number;
  /** Lint results as text, passed to the reviewer. */
  lintResults?: string;
  /** Prove suspected bugs by running tests (needs the project's dependencies installed). */
  verifyFindings: boolean;
  maxProofs?: number;
  testTimeoutMs: number;
}

export function parseSeverity(name: string, value: string): Severity | "none" {
  if (value !== "none" && !(SEVERITIES as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of none, ${SEVERITIES.join(", ")} (got "${value}")`);
  }
  return value as Severity | "none";
}

export async function runReview(ctx: TaskContext, options: ReviewOptions): Promise<TaskResult> {
  try {
    return await review(ctx, options);
  } catch (err) {
    // Running out of a free tier's quota shouldn't fail the PR: say so and move on.
    if (!(err instanceof AiQuotaError)) throw err;
    const note = `🐕 Watchdog AI review skipped: ${err.message}`;
    ctx.log.warning(note);
    await upsertSummary(ctx.octokit, ctx.pr, REVIEW_SUMMARY_MARKER, `${REVIEW_SUMMARY_MARKER}\n${note}`);
    return { summary: note, outputs: {} };
  }
}

async function review(ctx: TaskContext, options: ReviewOptions): Promise<TaskResult> {
  if (!ctx.ai) {
    const note =
      "🐕 Watchdog AI review skipped: add a free `GEMINI_API_KEY` secret (or an `ANTHROPIC_API_KEY`) to enable it.";
    ctx.log.warning(note);
    return { summary: note, outputs: {} };
  }
  const ai = ctx.ai;

  const paths = ctx.files.filter((f) => f.status !== "removed").map((f) => f.path);
  const contents = await fetchHeadContents(ctx, paths);
  const collected = collectReviewFiles(ctx.files, (p) => contents.get(p) ?? null, {
    ignorePaths: ctx.ignorePaths,
    // Defaults depend on the provider: free tiers get smaller prompts and fewer round trips.
    maxChars: options.maxChars || ai.reviewChars,
  });
  const reviewed = [...collected.files, ...collected.deferred];
  if (reviewed.length === 0) {
    ctx.log.info("No reviewable changes.");
    return { summary: "No reviewable changes.", outputs: {} };
  }

  const commits = await ctx.octokit.paginate(ctx.octokit.rest.pulls.listCommits, {
    owner: ctx.pr.owner,
    repo: ctx.pr.repo,
    pull_number: ctx.pr.pullNumber,
    per_page: 100,
  });
  const pr = { title: ctx.title, body: ctx.body, author: ctx.author, commits: commits.map((c) => c.commit.message) };
  const reviewOptions = {
    provider: ai,
    lintResults: options.lintResults,
    repoRoot: ctx.repoRoot,
    maxIterations: options.maxIterations || ai.maxIterations,
  };
  const { findings: raw, toolCalls } = await reviewPr(pr, collected, reviewOptions);
  const findings = validateFindings(raw, reviewed);

  // Prove suspected bugs by writing and running a test for each, when the repo's tests can run here.
  if (options.verifyFindings) {
    const runners = detectRunners(ctx.repoRoot);
    if (runners.size === 0) {
      ctx.log.info(
        "Skipping proof tests: no Vitest, Jest or pytest install found (install the project's dependencies first).",
      );
    } else {
      const proofs = await proveFindings(findings, {
        provider: ai,
        root: ctx.repoRoot,
        repo: fsRepo(ctx.repoRoot),
        runners,
        files: reviewed,
        maxProofs: options.maxProofs || ai.maxProofs,
        testTimeoutMs: options.testTimeoutMs,
      });
      for (const [i, proof] of proofs) findings[i]!.proof = proof;
      const counts = [...proofs.values()].reduce<Record<string, number>>(
        (acc, p) => ((acc[p.status] = (acc[p.status] ?? 0) + 1), acc),
        {},
      );
      ctx.log.info(`Proof tests: ${JSON.stringify(counts)}`);
    }
  }
  const summary = await summarize(
    pr,
    reviewed,
    findings.filter((f) => f.proof?.status !== "refuted"),
    reviewOptions,
  );

  const comments =
    options.minSeverity === "none" ? [] : reviewComments(findings, options.minSeverity, options.maxComments);
  const postedKeys = await postInlineComments(ctx.octokit, ctx.pr, comments, {
    reviewBody: (n) => `🐕 Watchdog found ${n} issue(s) in this PR. See the summary comment for the overview.`,
    isPosted: isDuplicate,
  });
  const markdown = reviewSummaryMarkdown({
    summary,
    findings,
    postedKeys,
    filesReviewed: reviewed.length,
    listed: collected.listed,
    toolCalls,
    model: ai.model,
  });
  await upsertSummary(ctx.octokit, ctx.pr, REVIEW_SUMMARY_MARKER, markdown);
  ctx.log.info(
    `Reviewed ${reviewed.length} file(s) with ${toolCalls} tool call(s): ${findings.length} finding(s), score ${summary?.score ?? "n/a"}.`,
  );

  const result: TaskResult = {
    summary: markdown,
    outputs: { score: summary?.score ?? "", findings: findings.length },
  };
  if (options.failOnSeverity !== "none") {
    const threshold = SEVERITIES.indexOf(options.failOnSeverity);
    const blocking = findings.filter((f) => SEVERITIES.indexOf(f.severity) <= threshold);
    if (blocking.length > 0) {
      result.failure = `${blocking.length} finding(s) at or above "${options.failOnSeverity}" severity.`;
    }
  }
  return result;
}
