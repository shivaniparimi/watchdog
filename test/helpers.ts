import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { RepoReader } from "../src/testMap.js";

export function memoryRepo(files: Record<string, string>): RepoReader {
  return {
    listFiles: () => Object.keys(files),
    read: (path) => files[path] ?? null,
  };
}

/** Build a unified-diff patch that adds every line of `content` (a brand-new file). */
export function addedFilePatch(content: string): string {
  const lines = content.split("\n");
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

/** Create a throwaway git repository with these files committed (git grep only searches tracked files). */
export function gitRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "watchdog-repo-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return root;
}

export const text = (t: string) => ({ type: "text", text: t });
export const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
export function message(content: unknown[], stopReason = "end_turn") {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/**
 * An Anthropic client whose HTTP layer replays `replies` in order and records each request body.
 * A reply built with message() is returned as-is; anything else is returned as JSON text
 * (what a structured-output request gets back).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- request bodies are inspected loosely in tests.
export function fakeClient(replies: unknown[]): { client: Anthropic; requests: any[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requests: any[] = [];
  const client = new Anthropic({
    apiKey: "test",
    maxRetries: 0,
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const reply = replies[requests.length - 1];
      if (reply === undefined) throw new Error(`Unexpected request #${requests.length}`);
      const body =
        typeof reply === "object" && reply !== null && (reply as { type?: string }).type === "message"
          ? reply
          : message([text(JSON.stringify(reply))]);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return { client, requests };
}
