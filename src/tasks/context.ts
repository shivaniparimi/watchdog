import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { createProvider, type AiProvider } from "../ai/index.js";
import { fetchFileAtHead, listPrFiles, type PrRef } from "../github.js";
import type { ChangedFile } from "../types.js";

export type Octokit = ReturnType<typeof getOctokit>;

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
}

export function listInput(name: string): string[] {
  return core
    .getInput(name)
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Load everything both tasks need from the pull_request event, or null when not run on a PR. */
export async function loadContext(): Promise<TaskContext | null> {
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
