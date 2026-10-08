import { getOctokit } from "@actions/github";
import type { AiProvider } from "../ai/index.js";
import { fetchFileAtHead, listPrFiles, type PrRef } from "../github.js";
import type { ChangedFile } from "../types.js";

export type Octokit = ReturnType<typeof getOctokit>;

export interface Logger {
  info(message: string): void;
  warning(message: string): void;
}

/** Everything a task needs about one pull request, however Watchdog was started (Action or server). */
export interface TaskContext {
  octokit: Octokit;
  pr: PrRef;
  title: string;
  body: string;
  author: string;
  files: ChangedFile[];
  ignorePaths: string[];
  /** Null when no API key was given; AI steps are then skipped. */
  ai: AiProvider | null;
  /** Checkout of the repository at the PR head, for the AI's tools and for running tests. */
  repoRoot: string;
  log: Logger;
}

/** What a task produced; the caller decides how to report it (job summary, HTTP response, logs). */
export interface TaskResult {
  summary: string;
  outputs: Record<string, string | number>;
  /** Set when the run should count as failed (e.g. findings at or above the fail-on level). */
  failure?: string;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(m),
  warning: (m) => console.warn(`warning: ${m}`),
};

/** Build a task context for a PR by number, using the GitHub API (used by the server). */
export async function contextForPr(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  ai: AiProvider | null;
  repoRoot: string;
  ignorePaths?: string[];
  log?: Logger;
}): Promise<TaskContext> {
  const { data: pull } = await args.octokit.rest.pulls.get({
    owner: args.owner,
    repo: args.repo,
    pull_number: args.pullNumber,
  });
  const pr: PrRef = { owner: args.owner, repo: args.repo, pullNumber: args.pullNumber, headSha: pull.head.sha };
  return {
    octokit: args.octokit,
    pr,
    title: pull.title,
    body: pull.body ?? "",
    author: pull.user?.login ?? "",
    files: await listPrFiles(args.octokit, pr),
    ignorePaths: args.ignorePaths ?? [],
    ai: args.ai,
    repoRoot: args.repoRoot,
    log: args.log ?? consoleLogger,
  };
}

/** Fetch exact PR-head contents of the given files (the checkout may be a merge commit with shifted lines). */
export async function fetchHeadContents(ctx: TaskContext, paths: string[]): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const path of paths) {
    const content = await fetchFileAtHead(ctx.octokit, ctx.pr, path);
    if (content !== null) contents.set(path, content);
  }
  return contents;
}
