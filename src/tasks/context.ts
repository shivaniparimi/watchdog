import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import Anthropic from "@anthropic-ai/sdk";
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
  /** Null when no API key was given. */
  anthropic: Anthropic | null;
  model: string;
}

export function listInput(name: string): string[] {
  return core
    .getInput(name)
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Load everything both tasks need from the pull_request event, or null when not run on a PR. */
export async function loadContext(defaultModel: string): Promise<TaskContext | null> {
  const pull = context.payload.pull_request;
  if (!pull) return null;

  const octokit = getOctokit(core.getInput("github-token", { required: true }));
  const pr: PrRef = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pullNumber: pull.number,
    headSha: pull.head.sha,
  };
  const apiKey = core.getInput("anthropic-api-key");
  if (apiKey) core.setSecret(apiKey);

  return {
    octokit,
    pr,
    title: pull.title ?? "",
    body: pull.body ?? "",
    author: pull.user?.login ?? "",
    files: await listPrFiles(octokit, pr),
    ignorePaths: listInput("ignore-paths"),
    anthropic: apiKey ? new Anthropic({ apiKey }) : null,
    model: core.getInput("model") || defaultModel,
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
