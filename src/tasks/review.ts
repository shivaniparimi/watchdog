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
import { reviewFiles, SEVERITIES, summarize, type Severity } from "../review/review.js";
import { fetchHeadContents, type TaskContext } from "./context.js";

function severityInput(name: string, fallback: Severity | "none"): Severity | "none" {
  const value = core.getInput(name) || fallback;
  if (value !== "none" && !(SEVERITIES as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of none, ${SEVERITIES.join(", ")} (got "${value}")`);
  }
  return value as Severity | "none";
}

export async function runReview(ctx: TaskContext): Promise<void> {
  if (!ctx.anthropic) {
    const note = "🐕 Watchdog AI review skipped: add an `ANTHROPIC_API_KEY` secret to enable it.";
    core.warning(note);
    await core.summary.addRaw(note).write();
    return;
  }

  const minSeverity = severityInput("min-severity", "minor");
  const failOn = severityInput("fail-on-severity", "none");
  const maxComments = Number(core.getInput("max-comments") || 15);
  const maxChars = Number(core.getInput("max-review-chars") || 300_000);

  const paths = ctx.files.filter((f) => f.status !== "removed").map((f) => f.path);
  const contents = await fetchHeadContents(ctx, paths);
  const { files, skipped } = collectReviewFiles(ctx.files, (p) => contents.get(p) ?? null, {
    ignorePaths: ctx.ignorePaths,
    maxChars,
  });
  if (files.length === 0) {
    core.info("No reviewable code changes.");
    return;
  }

  const pr = { title: ctx.title, body: ctx.body, author: ctx.author };
  const options = {
    client: ctx.anthropic,
    model: ctx.model,
    lintResults: readLintResults(core.getInput("lint-results") || undefined),
  };
  const findings = validateFindings(await reviewFiles(pr, files, options), files);
  const summary = await summarize(pr, files, findings, options);

  const comments = minSeverity === "none" ? [] : reviewComments(findings, minSeverity, maxComments);
  const postedKeys = await postInlineComments(ctx.octokit, ctx.pr, comments, {
    reviewBody: (n) => `🐕 Watchdog found ${n} issue(s) in this PR. See the summary comment for the overview.`,
    isPosted: isDuplicate,
  });
  const markdown = reviewSummaryMarkdown({
    summary,
    findings,
    postedKeys,
    filesReviewed: files.length,
    skipped,
    model: ctx.model,
  });
  await upsertSummary(ctx.octokit, ctx.pr, REVIEW_SUMMARY_MARKER, markdown);
  await core.summary.addRaw(markdown).write();

  core.setOutput("score", summary?.score ?? "");
  core.setOutput("findings", findings.length);
  core.info(`Reviewed ${files.length} file(s): ${findings.length} finding(s), score ${summary?.score ?? "n/a"}.`);

  if (failOn !== "none") {
    const threshold = SEVERITIES.indexOf(failOn);
    const blocking = findings.filter((f) => SEVERITIES.indexOf(f.severity) <= threshold);
    if (blocking.length > 0) core.setFailed(`${blocking.length} finding(s) at or above "${failOn}" severity.`);
  }
}
