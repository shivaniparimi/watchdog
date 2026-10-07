import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgent } from "../src/agent/agent.js";
import { repoTools, safePath } from "../src/agent/repoTools.js";
import { fakeClient, gitRepo, message, text, toolUse } from "./helpers.js";

const files = {
  "src/cart.ts": Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join("\n"),
  "src/pay.ts": "export function pay(n: number) {\n  return charge(n);\n}\n",
  "test/pay.test.ts": "import { pay } from '../src/pay';\nit('pays', () => pay(1));\n",
};

function tools(root: string, diffs = new Map<string, string>()) {
  const [readFile, search, list, diff] = repoTools(root, diffs);
  return { readFile: readFile!, search: search!, list: list!, diff: diff! };
}

describe("safePath", () => {
  it("rejects paths that escape the repository or reach hidden folders", () => {
    const root = gitRepo(files);
    symlinkSync("/etc", join(root, "escape"));
    expect(safePath(root, "src/pay.ts")).not.toBeNull();
    expect(safePath(root, "../outside.txt")).toBeNull();
    expect(safePath(root, "src/../../outside.txt")).toBeNull();
    expect(safePath(root, "/etc/passwd")).toBeNull();
    expect(safePath(root, ".git/config")).toBeNull();
    expect(safePath(root, ".watchdog/action.yml")).toBeNull();
    expect(safePath(root, "escape/passwd")).toBeNull();
  });
});

describe("repoTools", () => {
  it("read_file returns numbered lines in pages and refuses unsafe paths", async () => {
    const { readFile } = tools(gitRepo(files));
    const first = await readFile.run({ path: "src/cart.ts" });
    expect(first).toContain("src/cart.ts (lines 1-400 of 450)\n1: line 1\n");
    expect(first).toContain("…(50 more lines; call again with start_line=401)");
    expect(await readFile.run({ path: "src/cart.ts", start_line: 449 })).toBe(
      "src/cart.ts (lines 449-450 of 450)\n449: line 449\n450: line 450",
    );
    expect(await readFile.run({ path: "../secret" })).toMatch(/outside the repository/);
    expect(await readFile.run({ path: "nope.ts" })).toMatch(/does not exist/);
    expect(await readFile.run({ path: "src" })).toMatch(/is a directory/);
  });

  it("search_code finds tracked matches, as text or regex, optionally by glob", async () => {
    const { search } = tools(gitRepo(files));
    expect(await search.run({ pattern: "pay(" })).toBe(
      "src/pay.ts:1:export function pay(n: number) {\ntest/pay.test.ts:2:it('pays', () => pay(1));",
    );
    expect(await search.run({ pattern: "pay\\([0-9]\\)", regex: true })).toBe(
      "test/pay.test.ts:2:it('pays', () => pay(1));",
    );
    expect(await search.run({ pattern: "pay", path_glob: "test/**" })).not.toMatch(/^src\//m);
    expect(await search.run({ pattern: "no such thing" })).toBe("No matches.");
  });

  it("list_files lists tracked files by directory or glob", async () => {
    const { list } = tools(gitRepo(files));
    expect(await list.run({ directory: "src" })).toBe("src/cart.ts\nsrc/pay.ts");
    expect(await list.run({ glob: "**/*.test.ts" })).toBe("test/pay.test.ts");
    expect(await list.run({ directory: "../" })).toMatch(/outside the repository/);
  });

  it("get_diff returns a changed file's diff", async () => {
    const { diff } = tools(gitRepo(files), new Map([["src/pay.ts", "L2 + return charge(n);"]]));
    expect(await diff.run({ path: "src/pay.ts" })).toBe("L2 + return charge(n);");
    expect(await diff.run({ path: "src/cart.ts" })).toMatch(/isn't one of this PR's changed files/);
  });
});

describe("runAgent", () => {
  const schema = z.object({ answers: z.array(z.string()) });
  const submit = { name: "submit", description: "Submit.", schema };

  it("runs exploration tools and returns what Claude submits", async () => {
    const root = gitRepo(files);
    const { client, requests } = fakeClient([
      message([toolUse("a", "read_file", { path: "src/pay.ts" })], "tool_use"),
      message([toolUse("b", "submit", { answers: ["pay calls charge"] })], "tool_use"),
      message([text("Done.")]),
    ]);
    const result = await runAgent({ client, model: "m", system: "s", user: "u", tools: repoTools(root), submit });
    expect(result).toEqual({ output: { answers: ["pay calls charge"] }, toolCalls: 1 });
    expect(requests[1].messages.at(-1).content[0].content).toContain("1: export function pay(n: number) {");
    expect(requests[0].tools.at(-1)).toMatchObject({ name: "submit", strict: true });
  });

  it("asks once more when Claude stops without submitting", async () => {
    const { client, requests } = fakeClient([
      message([text("I think it's fine.")]),
      message([toolUse("b", "submit", { answers: [] })], "tool_use"),
      message([text("Done.")]),
    ]);
    const result = await runAgent({ client, model: "m", system: "s", user: "u", tools: [], submit });
    expect(result.output).toEqual({ answers: [] });
    expect(requests[1].messages.at(-1).content.at(-1).text).toMatch(/^Call submit now/);
  });

  it("answers calls cut off by the iteration cap before asking again", async () => {
    const root = gitRepo(files);
    const { client, requests } = fakeClient([
      message([toolUse("a", "list_files", {})], "tool_use"),
      message([toolUse("b", "list_files", {})], "tool_use"),
      message([toolUse("c", "submit", { answers: ["x"] })], "tool_use"),
      message([text("Done.")]),
    ]);
    const result = await runAgent({
      client,
      model: "m",
      system: "s",
      user: "u",
      tools: repoTools(root),
      submit,
      maxIterations: 2,
    });
    expect(result.output).toEqual({ answers: ["x"] });
    const nudge = requests[2].messages.at(-1).content;
    expect(nudge[0]).toMatchObject({ type: "tool_result", tool_use_id: "b", is_error: true });
    expect(nudge.at(-1).text).toMatch(/^Call submit now/);
  });
});
