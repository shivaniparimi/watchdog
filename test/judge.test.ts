import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { judge } from "../src/judge.js";
import type { AnalyzedSymbol } from "../src/types.js";

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
    {
      path: "src/cart.test.ts",
      changedInPr: false,
      excerpt: '8:   expect(applyDiscount(10, "HALF")).toBe(5);',
    },
  ],
};

/** A client whose HTTP layer returns `reply` as Claude's text and records the request body. */
function fakeClient(reply: unknown, stopReason = "end_turn") {
  const requests: any[] = [];
  const client = new Anthropic({
    apiKey: "test",
    maxRetries: 0,
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const message = {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: JSON.stringify(reply) }],
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      };
      return new Response(JSON.stringify(message), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, requests };
}

describe("judge", () => {
  it("sends a structured-output request and maps verdicts by id", async () => {
    const { client, requests } = fakeClient({
      verdicts: [
        {
          id: sym.id,
          covered: false,
          risk: "medium",
          reason: "TENOFF branch untested.",
          suggested_test: "it('tenoff', ...)",
        },
        {
          id: "not-asked-about",
          covered: false,
          risk: "high",
          reason: "x",
          suggested_test: "",
        },
      ],
    });
    const verdicts = await judge([sym], { client });

    expect(verdicts.size).toBe(1);
    expect(verdicts.get(sym.id)).toMatchObject({
      covered: false,
      risk: "medium",
      source: "ai",
    });

    const body = requests[0];
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.fallbacks).toBe("default");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.output_config.effort).toBe("medium");
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[0].content).toContain('<function id="src/cart.ts#applyDiscount@7">');
  });

  it("forces risk to none when Claude says the change is covered", async () => {
    const { client } = fakeClient({
      verdicts: [
        {
          id: sym.id,
          covered: true,
          risk: "low",
          reason: "Tested.",
          suggested_test: "",
        },
      ],
    });
    expect((await judge([sym], { client })).get(sym.id)?.risk).toBe("none");
  });

  it("returns no verdicts on a refusal instead of throwing", async () => {
    const { client } = fakeClient({ verdicts: [] }, "refusal");
    expect((await judge([sym], { client })).size).toBe(0);
  });
});

describe("judge with repository access", () => {
  it("lets Claude search for tests the rule check missed, then maps its verdicts", async () => {
    const { fakeClient, gitRepo, message, text, toolUse } = await import("./helpers.js");
    const root = gitRepo({ "test/checkout.test.ts": "it('discounts', () => checkout('TENOFF'));\n" });
    const { client, requests } = fakeClient([
      message([toolUse("a", "search_code", { pattern: "TENOFF" })], "tool_use"),
      message(
        [
          toolUse("b", "submit_verdicts", {
            verdicts: [
              {
                id: sym.id,
                covered: true,
                risk: "low",
                reason: "test/checkout.test.ts covers it.",
                suggested_test: "",
              },
            ],
          }),
        ],
        "tool_use",
      ),
      message([text("Done.")]),
    ]);
    const verdicts = await judge([sym], { client, repoRoot: root });
    expect(verdicts.get(sym.id)).toMatchObject({ covered: true, risk: "none", source: "ai" });
    expect(requests[0].system).toContain("use search_code to look for tests");
    expect(requests[1].messages.at(-1).content[0].content).toContain("test/checkout.test.ts:1:");
  });
});
