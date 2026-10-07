import type { getOctokit } from "@actions/github";
import type { InlineComment } from "./report.js";
import type { ChangedFile } from "./types.js";

type Octokit = ReturnType<typeof getOctokit>;

export interface PrRef {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
}

export async function listPrFiles(octokit: Octokit, pr: PrRef): Promise<ChangedFile[]> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.pullNumber,
    per_page: 100,
  });
  return files.map((f) => ({
    path: f.filename,
    status: f.status,
    patch: f.patch,
  }));
}

/** Fetch a file's exact content at the PR head (the checkout may be a merge commit with shifted lines). */
export async function fetchFileAtHead(octokit: Octokit, pr: PrRef, path: string): Promise<string | null> {
  try {
    const res = await octokit.rest.repos.getContent({
      owner: pr.owner,
      repo: pr.repo,
      path,
      ref: pr.headSha,
      mediaType: { format: "raw" },
    });
    return typeof res.data === "string" ? res.data : null;
  } catch {
    return null;
  }
}

function hasStatus(err: unknown, status: number): boolean {
  return typeof err === "object" && err !== null && "status" in err && err.status === status;
}

export interface PostOptions {
  /** Text of the review that holds the inline comments. */
  reviewBody: (count: number) => string;
  /** Has an earlier run already posted this comment? Gets the bodies of all existing review comments. */
  isPosted: (comment: InlineComment, existingBodies: string[]) => boolean;
}

function reviewComment(c: InlineComment) {
  return {
    path: c.path,
    line: c.line,
    side: "RIGHT" as const,
    ...(c.startLine !== undefined ? { start_line: c.startLine, start_side: "RIGHT" as const } : {}),
    body: c.body,
  };
}

/**
 * Post inline comments as one review, skipping any an earlier run already posted.
 * Returns the keys of comments that are now on the PR (posted now or before).
 */
export async function postInlineComments(
  octokit: Octokit,
  pr: PrRef,
  comments: InlineComment[],
  options: PostOptions,
): Promise<Set<string>> {
  const existing = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.pullNumber,
    per_page: 100,
  });
  const bodies = existing.map((c) => c.body);
  const onPr = new Set<string>();
  const fresh: InlineComment[] = [];
  for (const c of comments) {
    if (options.isPosted(c, bodies)) onPr.add(c.key);
    else fresh.push(c);
  }
  if (fresh.length === 0) return onPr;

  try {
    await octokit.rest.pulls.createReview({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.pullNumber,
      commit_id: pr.headSha,
      event: "COMMENT",
      body: options.reviewBody(fresh.length),
      comments: fresh.map(reviewComment),
    });
    for (const c of fresh) onPr.add(c.key);
    return onPr;
  } catch (err) {
    // 422 means GitHub rejected at least one comment's line; the whole review fails, so post one at a time.
    if (!hasStatus(err, 422)) throw err;
  }

  for (const c of fresh) {
    try {
      await octokit.rest.pulls.createReviewComment({
        owner: pr.owner,
        repo: pr.repo,
        pull_number: pr.pullNumber,
        commit_id: pr.headSha,
        ...reviewComment(c),
      });
      onPr.add(c.key);
    } catch (err) {
      console.warn(`Couldn't comment on ${c.path}:${c.line}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return onPr;
}

/** Create the summary comment identified by `marker`, or update the one posted on an earlier run. */
export async function upsertSummary(octokit: Octokit, pr: PrRef, marker: string, body: string): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.pullNumber,
    per_page: 100,
  });
  const mine = comments.find((c) => c.body?.includes(marker));
  if (mine) {
    await octokit.rest.issues.updateComment({
      owner: pr.owner,
      repo: pr.repo,
      comment_id: mine.id,
      body,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.pullNumber,
      body,
    });
  }
}
