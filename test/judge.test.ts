import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/ai/anthropic.js";
import { judge } from "../src/judge.js";
import type { AnalyzedSymbol } from "../src/types.js";
import { fakeClient, gitRepo, message, text, toolUse } from "./helpers.js";

const sym: AnalyzedSymbol = {
  id: "src/cart.ts#applyDiscount@7",
  path: "src/cart.ts",
  language: "ts",
  name: "applyDiscount",
  start: 7,
  end: 15,
  isNew: false,
  changedLines: [11, 12],
  diffSnippet: 'L11 +   if (code === "TENOFF" && total > 50) {',
  body: "export function applyDiscount(...) { ... }",
  status: "needs-judgment",
  candidateTests: ["src/cart.test.ts"],
  evidence: [
    { path: "src/cart.test.ts", changedInPr: false, excerpt: '8:   expect(applyDiscount(10, "HALF")).toBe(5);' },
  ],
};

const verdict = (over: object = {}) => ({
  id: sym.id,
  covered: false,
  risk: "medium",
  reason: "TENOFF branch untested.",
  suggested_test: "it('tenoff', ...)",
  ...over,
});

function submitted(verdicts: object[]) {
  return [message([toolUse("v", "submit_verdicts", { verdicts })], "tool_use"), message([text("Done.")])];
}

describe("judge", () => {
  it("submits verdicts through a tool and maps them by id, ignoring unknown ids", async () => {
    const { client, requests } = fakeClient(submitted([verdict(), verdict({ id: "not-asked-about", risk: "high" })]));
    const verdicts = await judge([sym], { provider: new AnthropicProvider(client) });

    expect(verdicts.size).toBe(1);
    expect(verdicts.get(sym.id)).toMatchObject({ covered: false, risk: "medium", source: "ai" });
    const body = requests[0];
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.fallbacks).toBe("default");
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(["submit_verdicts"]);
    expect(body.messages[0].content).toContain('<function id="src/cart.ts#applyDiscount@7">');
  });

  it("forces risk to none when the change is covered", async () => {
    const { client } = fakeClient(submitted([verdict({ covered: true, risk: "low" })]));
    expect((await judge([sym], { provider: new AnthropicProvider(client) })).get(sym.id)?.risk).toBe("none");
  });

  it("returns no verdicts on a refusal instead of throwing", async () => {
    const { client } = fakeClient([message([], "refusal")]);
    expect((await judge([sym], { provider: new AnthropicProvider(client) })).size).toBe(0);
  });

  it("with repository access, lets the model search for tests the rule check missed", async () => {
    const root = gitRepo({ "test/checkout.test.ts": "it('discounts', () => checkout('TENOFF'));\n" });
    const { client, requests } = fakeClient([
      message([toolUse("a", "search_code", { pattern: "TENOFF" })], "tool_use"),
      ...submitted([verdict({ covered: true, reason: "test/checkout.test.ts covers it." })]),
    ]);
    const verdicts = await judge([sym], { provider: new AnthropicProvider(client), repoRoot: root });
    expect(verdicts.get(sym.id)).toMatchObject({ covered: true, risk: "none", source: "ai" });
    expect(requests[0].system).toContain("use search_code to look for tests");
    expect(requests[1].messages.at(-1).content[0].content).toContain("test/checkout.test.ts:1:");
  });
});
