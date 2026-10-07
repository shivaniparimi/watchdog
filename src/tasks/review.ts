import * as core from "@actions/core";
import { postInlineComments, upsertSummary } from "../github.js";
import { collectReviewFiles } from "../review/collect.js";
import { readLintResults } from "../review/lintResults.js";
import {
  REVIEW_SUMMARY_MARKER,
  isDuplicate,
  reviewComments,
  reviewSummaryMarkdown,
  validateFindings,
} from "../review/report.js";
import { reviewPr, SEVERITIES, summarize, type Severity } from "../review/review.js";
import { AiQuotaError } from "../ai/index.js";
import { fsRepo } from "../repo.js";
import { proveFindings } from "../verify/prove.js";
import { detectRunners } from "../verify/runner.js";
import { fetchHeadContents, type TaskContext } from "./context.js";

function severityInput(name: string, fallback: Severity | "none"): Severity | "none" {
  const value = core.getInput(name) || fallback;
  if (value !== "none" && !(SEVERITIES as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of none, ${SEVERITIES.join(", ")} (got "${value}")`);
  }
  return value as Severity | "none";
}

export async function runReview(ctx: TaskContext): Promise<void> {
  try {
    await review(ctx);
  } catch (err) {
    // Running out of a free tier's quota shouldn't fail the PR: say so and move on.
    if (!(err instanceof AiQuotaError)) throw err;
    const note = `🐕 Watchdog AI review skipped: ${err.message}`;
    core.warning(note);
    await upsertSummary(ctx.octokit, ctx.pr, REVIEW_SUMMARY_MARKER, `${REVIEW_SUMMARY_MARKER}\n${note}`);
    await core.summary.addRaw(note).write();
  }
}

async function review(ctx: TaskContext): Promise<void> {
  if (!ctx.ai) {
    const note =
      "🐕 Watchdog AI review skipped: add a free `GEMINI_API_KEY` secret (or an `ANTHROPIC_API_KEY`) to enable it.";
    core.warning(note);
    await core.summary.addRaw(note).write();
    return;
  }

  const minSeverity = severityInput("min-severity", "minor");
  const failOn = severityInput("fail-on-severity", "none");
  const maxComments = Number(core.getInput("max-comments") || 15);
  const ai = ctx.ai;
  // Defaults depend on the provider: free tiers get smaller prompts and fewer round trips.
  const maxChars = Number(core.getInput("max-review-chars")) || ai.reviewChars;
  const maxIterations = Number(core.getInput("max-iterations")) || ai.maxIterations;

  const paths = ctx.files.filter((f) => f.status !== "removed").map((f) => f.path);
  const contents = await fetchHeadContents(ctx, paths);
  const collected = collectReviewFiles(ctx.files, (p) => contents.get(p) ?? null, {
    ignorePaths: ctx.ignorePaths,
    maxChars,
  });
  const reviewed = [...collected.files, ...collected.deferred];
  if (reviewed.length === 0) {
    core.info("No reviewable changes.");
    return;
  }

  const commits = await ctx.octokit.paginate(ctx.octokit.rest.pulls.listCommits, {
    owner: ctx.pr.owner,
    repo: ctx.pr.repo,
    pull_number: ctx.pr.pullNumber,
    per_page: 100,
  });
  const pr = { title: ctx.title, body: ctx.body, author: ctx.author, commits: commits.map((c) => c.commit.message) };
  const options = {
    provider: ai,
    lintResults: readLintResults(core.getInput("lint-results") || undefined),
    repoRoot: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    maxIterations,
  };
  const { findings: raw, toolCalls } = await reviewPr(pr, collected, options);
  const findings = validateFindings(raw, reviewed);

  // Prove suspected bugs by writing and running a test for each, when the repo's tests can run here.
  if (core.getBooleanInput("verify-findings")) {
    const runners = detectRunners(options.repoRoot);
    if (runners.size === 0) {
      core.info(
        "Skipping proof tests: no Vitest, Jest or pytest install found (install the project's dependencies first).",
      );
    } else {
      const proofs = await proveFindings(findings, {
        provider: ai,
        root: options.repoRoot,
        repo: fsRepo(options.repoRoot),
        runners,
        files: reviewed,
        maxProofs: Number(core.getInput("max-proofs")) || ai.maxProofs,
        testTimeoutMs: Number(core.getInput("test-timeout") || 120) * 1000,
      });
      for (const [i, proof] of proofs) findings[i]!.proof = proof;
      const counts = [...proofs.values()].reduce<Record<string, number>>(
        (acc, p) => ((acc[p.status] = (acc[p.status] ?? 0) + 1), acc),
        {},
      );
      core.info(`Proof tests: ${JSON.stringify(counts)}`);
    }
  }
  const summary = await summarize(
    pr,
    reviewed,
    findings.filter((f) => f.proof?.status !== "refuted"),
    options,
  );

  const comments = minSeverity === "none" ? [] : reviewComments(findings, minSeverity, maxComments);
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
  await core.summary.addRaw(markdown).write();

  core.setOutput("score", summary?.score ?? "");
  core.setOutput("findings", findings.length);
  core.info(
    `Reviewed ${reviewed.length} file(s) with ${toolCalls} tool call(s): ${findings.length} finding(s), score ${summary?.score ?? "n/a"}.`,
  );

  if (failOn !== "none") {
    const threshold = SEVERITIES.indexOf(failOn);
    const blocking = findings.filter((f) => SEVERITIES.indexOf(f.severity) <= threshold);
    if (blocking.length > 0) core.setFailed(`${blocking.length} finding(s) at or above "${failOn}" severity.`);
  }
}
