import type { getOctokit } from "@actions/github";
import { SUMMARY_MARKER, type InlineComment } from "./report.js";
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
  return files.map((f) => ({ path: f.filename, status: f.status, patch: f.patch }));
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

/** Post inline comments as one review, skipping any this action already posted. Returns how many were posted. */
export async function postInlineComments(octokit: Octokit, pr: PrRef, comments: InlineComment[]): Promise<number> {
  const existing = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.pullNumber,
    per_page: 100,
  });
  const posted = new Set(existing.map((c) => c.body.match(/<!-- test-gap:[^>]+ -->/)?.[0]).filter(Boolean));
  const fresh = comments.filter((c) => !posted.has(c.key));
  if (fresh.length === 0) return 0;

  try {
    await octokit.rest.pulls.createReview({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.pullNumber,
      commit_id: pr.headSha,
      event: "COMMENT",
      body: `🧪 Test gap finder: ${fresh.length} changed function(s) look untested. See the summary comment for the full list.`,
      comments: fresh.map((c) => ({ path: c.path, line: c.line, side: "RIGHT" as const, body: c.body })),
    });
    return fresh.length;
  } catch (err) {
    // 422 means GitHub rejected at least one comment's line; the whole review fails, so post one at a time.
    if (!hasStatus(err, 422)) throw err;
  }

  let count = 0;
  for (const c of fresh) {
    try {
      await octokit.rest.pulls.createReviewComment({
        owner: pr.owner,
        repo: pr.repo,
        pull_number: pr.pullNumber,
        commit_id: pr.headSha,
        path: c.path,
        line: c.line,
        side: "RIGHT",
        body: c.body,
      });
      count++;
    } catch (err) {
      console.warn(`Couldn't comment on ${c.path}:${c.line}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return count;
}

/** Create the summary comment, or update the one posted on an earlier run. */
export async function upsertSummary(octokit: Octokit, pr: PrRef, body: string): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.pullNumber,
    per_page: 100,
  });
  const mine = comments.find((c) => c.body?.includes(SUMMARY_MARKER));
  if (mine) {
    await octokit.rest.issues.updateComment({ owner: pr.owner, repo: pr.repo, comment_id: mine.id, body });
  } else {
    await octokit.rest.issues.createComment({ owner: pr.owner, repo: pr.repo, issue_number: pr.pullNumber, body });
  }
}
