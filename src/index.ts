/** GitHub Action entry point: read the Action's inputs, run one task, and report through Actions. */
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { createProvider } from "./ai/index.js";
import { listPrFiles, type PrRef } from "./github.js";
import { readLintResults } from "./review/lintResults.js";
import type { TaskContext, TaskResult } from "./tasks/context.js";
import { parseSeverity, runReview } from "./tasks/review.js";
import { parseFailOn, runTestGap } from "./tasks/testGap.js";

function listInput(name: string): string[] {
  return core
    .getInput(name)
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Build the task context from the pull_request event, or null when not run on a PR. */
async function loadContext(): Promise<TaskContext | null> {
  const pull = context.payload.pull_request;
  if (!pull) return null;

  const octokit = getOctokit(core.getInput("github-token", { required: true }));
  const pr: PrRef = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pullNumber: pull.number,
    headSha: core.getInput("head-sha") || pull.head.sha,
  };
  const geminiApiKey = core.getInput("gemini-api-key");
  const anthropicApiKey = core.getInput("anthropic-api-key");
  for (const key of [geminiApiKey, anthropicApiKey]) if (key) core.setSecret(key);
  const provider = (core.getInput("ai-provider") || "auto") as "auto" | "gemini" | "anthropic";
  if (!["auto", "gemini", "anthropic"].includes(provider)) {
    throw new Error(`ai-provider must be auto, gemini or anthropic (got "${provider}")`);
  }

  return {
    octokit,
    pr,
    title: pull.title ?? "",
    body: pull.body ?? "",
    author: pull.user?.login ?? "",
    files: await listPrFiles(octokit, pr),
    ignorePaths: listInput("ignore-paths"),
    ai: createProvider({ provider, geminiApiKey, anthropicApiKey, model: core.getInput("model") }),
    repoRoot: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    log: { info: core.info, warning: core.warning },
  };
}

async function run(): Promise<void> {
  const task = core.getInput("task") || "review";
  if (task !== "review" && task !== "test-gap") throw new Error(`task must be "review" or "test-gap" (got "${task}")`);

  const ctx = await loadContext();
  if (!ctx) {
    core.info("Not a pull_request event; nothing to do.");
    return;
  }
  const testTimeoutMs = Number(core.getInput("test-timeout") || 120) * 1000;

  let result: TaskResult;
  if (task === "review") {
    result = await runReview(ctx, {
      minSeverity: parseSeverity("min-severity", core.getInput("min-severity") || "minor"),
      failOnSeverity: parseSeverity("fail-on-severity", core.getInput("fail-on-severity") || "none"),
      maxComments: Number(core.getInput("max-comments") || 15),
      maxChars: Number(core.getInput("max-review-chars")) || undefined,
      maxIterations: Number(core.getInput("max-iterations")) || undefined,
      lintResults: readLintResults(core.getInput("lint-results") || undefined),
      verifyFindings: core.getBooleanInput("verify-findings"),
      maxProofs: Number(core.getInput("max-proofs")) || undefined,
      testTimeoutMs,
    });
  } else {
    result = await runTestGap(ctx, {
      failOn: parseFailOn(core.getInput("fail-on") || "none"),
      maxFunctions: Number(core.getInput("max-functions") || 40),
      mutationTesting: core.getBooleanInput("mutation-testing"),
      maxMutants: Number(core.getInput("max-mutants") || 30),
      mutationBudgetMs: Number(core.getInput("mutation-budget") || 600) * 1000,
      testTimeoutMs,
    });
  }

  await core.summary.addRaw(result.summary).write();
  for (const [name, value] of Object.entries(result.outputs)) core.setOutput(name, value);
  if (result.failure) core.setFailed(result.failure);
}

run().catch((err) => core.setFailed(err instanceof Error ? err.message : String(err)));
