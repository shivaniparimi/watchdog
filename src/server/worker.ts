import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getOctokit } from "@actions/github";
import type { AiProvider } from "../ai/index.js";
import { consoleLogger, contextForPr, type Logger } from "../tasks/context.js";
import { runReview } from "../tasks/review.js";
import { runTestGap } from "../tasks/testGap.js";
import type { Job, TaskName, TaskOutcome, Worker } from "./jobs.js";

const run = promisify(execFile);

export interface WorkerConfig {
  githubToken: string;
  ai: AiProvider | null;
  /**
   * Run the project's tests (proof tests, mutation check). Off by default: it executes code from the
   * PR on this server. Only enable it for repositories you trust, ideally in an isolated container.
   */
  runTests: boolean;
  ignorePaths?: string[];
  log?: Logger;
}

/**
 * Check out exactly the PR's head commit. The token goes in an HTTP header passed through
 * environment variables, so it never appears in a command line or in the clone's git config.
 */
export async function checkoutCommit(
  dir: string,
  owner: string,
  repo: string,
  sha: string,
  token: string,
): Promise<void> {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
  const git = (...args: string[]) => run("git", args, { cwd: dir, env, maxBuffer: 16 * 1024 * 1024 });
  await git("init", "-q");
  await git("fetch", "-q", "--depth", "1", `https://github.com/${owner}/${repo}.git`, sha);
  await git("checkout", "-q", "FETCH_HEAD");
}

/** The worker the server's job queue runs: check out the PR, run each task, clean up. */
export function createWorker(config: WorkerConfig): Worker {
  const log = config.log ?? consoleLogger;
  const octokit = getOctokit(config.githubToken);

  return async (job: Job) => {
    const dir = await mkdtemp(join(tmpdir(), "watchdog-"));
    const results: Partial<Record<TaskName, TaskOutcome>> = {};
    try {
      const { data: pull } = await octokit.rest.pulls.get({
        owner: job.owner,
        repo: job.repo,
        pull_number: job.pullNumber,
      });
      await checkoutCommit(dir, job.owner, job.repo, pull.head.sha, config.githubToken);
      const ctx = await contextForPr({
        octokit,
        owner: job.owner,
        repo: job.repo,
        pullNumber: job.pullNumber,
        ai: config.ai,
        repoRoot: dir,
        ignorePaths: config.ignorePaths,
        log,
      });
      log.info(`${job.owner}/${job.repo}#${job.pullNumber}: running ${job.tasks.join(", ")}`);

      for (const task of job.tasks) {
        const result =
          task === "review"
            ? await runReview(ctx, {
                minSeverity: "minor",
                failOnSeverity: "none",
                maxComments: 15,
                verifyFindings: config.runTests,
                testTimeoutMs: 120_000,
              })
            : await runTestGap(ctx, {
                failOn: "none",
                maxFunctions: 40,
                mutationTesting: config.runTests,
                maxMutants: 30,
                mutationBudgetMs: 600_000,
                testTimeoutMs: 120_000,
              });
        results[task] = { outputs: result.outputs, failure: result.failure };
      }
      return results;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
