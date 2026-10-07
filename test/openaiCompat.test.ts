import { describe, expect, it } from "vitest";
import { z } from "zod";
import { repoToolList } from "../src/agent/repoTools.js";
import { createProvider } from "../src/ai/index.js";
import { OpenAICompatProvider, parseRetryDelayMs, toFunctionSchema } from "../src/ai/openaiCompat.js";
import { AiQuotaError } from "../src/ai/types.js";
import { gitRepo } from "./helpers.js";

type Reply = { status?: number; headers?: Record<string, string>; body: unknown };

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});
const reply = (message: object): Reply => ({ body: { choices: [{ message: { role: "assistant", ...message } }] } });

/** A provider whose HTTP layer replays `replies` in order and records each request body. */
function fake(replies: Reply[], fallbackModels: string[] = []) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- request bodies are inspected loosely in tests.
  const requests: any[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    requests.push(JSON.parse(String(init?.body)));
    const r = replies[requests.length - 1];
    if (!r) throw new Error(`Unexpected request #${requests.length}`);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  const provider = new OpenAICompatProvider({
    baseUrl: "https://example.test/v1beta/openai/",
    apiKey: "key",
    model: "gemini-test",
    fallbackModels,
    fetch: fetchImpl,
    retryDelayMs: 0,
  });
  return { provider, requests, urls };
}

const schema = z.object({ answers: z.array(z.string()), note: z.string().nullable() });
const submit = { name: "submit", description: "Submit.", schema };

describe("toFunctionSchema", () => {
  it("drops fields Gemini rejects and writes nullables as nullable: true", () => {
    const out = toFunctionSchema(schema) as { properties: Record<string, object>; $schema?: string };
    expect(out.$schema).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("additionalProperties");
    expect(out.properties.note).toEqual({ type: "string", nullable: true });
    expect(out.properties.answers).toEqual({ type: "array", items: { type: "string" } });
  });
});

describe("OpenAICompatProvider.runAgent", () => {
  it("runs tools, keeps assistant messages as returned, and stops once the answer is submitted", async () => {
    const root = gitRepo({ "src/pay.ts": "export const pay = 1;\n" });
    const { provider, requests, urls } = fake([
      reply({ tool_calls: [call("a", "search_code", { pattern: "pay" })], extra_content: { signature: "sig" } }),
      reply({ tool_calls: [call("b", "submit", { answers: ["ok"], note: null })] }),
    ]);
    const result = await provider.runAgent({ system: "sys", user: "hi", tools: repoToolList(root), submit });

    expect(result).toEqual({ output: { answers: ["ok"], note: null }, toolCalls: 1 });
    expect(urls[0]).toBe("https://example.test/v1beta/openai/chat/completions");
    expect(requests[0]).toMatchObject({ model: "gemini-test", tool_choice: "auto" });
    expect(requests[0].messages.slice(0, 2)).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(requests[0].tools.map((t: { function: { name: string } }) => t.function.name)).toContain("submit");
    // Gemini's extra fields (thought signatures) are sent back untouched, followed by the tool result.
    const [assistant, toolResult] = requests[1].messages.slice(2);
    expect(assistant.extra_content).toEqual({ signature: "sig" });
    expect(toolResult).toMatchObject({ role: "tool", tool_call_id: "a" });
    expect(toolResult.content).toContain("src/pay.ts:1:export const pay = 1;");
  });

  it("returns schema errors to the model so it can correct its call", async () => {
    const { provider, requests } = fake([
      reply({ tool_calls: [call("a", "submit", { answers: "not a list" })] }),
      reply({ tool_calls: [call("b", "submit", { answers: [], note: "fixed" })] }),
    ]);
    const result = await provider.runAgent({ system: "s", user: "u", tools: [], submit });
    expect(result.output).toEqual({ answers: [], note: "fixed" });
    expect(requests[1].messages.at(-1).content).toMatch(/^Error: invalid arguments for submit/);
  });

  it("handles malformed JSON and unknown tools", async () => {
    const { provider, requests } = fake([
      reply({ tool_calls: [call("a", "submit", "{oops"), call("b", "rm_rf", {})] }),
      reply({ tool_calls: [call("c", "submit", { answers: [], note: null })] }),
    ]);
    await provider.runAgent({ system: "s", user: "u", tools: [], submit });
    const [, , , bad, unknown] = requests[1].messages;
    expect(bad.content).toMatch(/not valid JSON/);
    expect(unknown.content).toBe("Error: there is no tool named rm_rf.");
  });

  it("requires the submit call after a nudge, and falls back to auto if tool_choice is rejected", async () => {
    const { provider, requests } = fake([
      reply({ content: "Here are my findings in prose." }),
      { status: 400, body: { error: { message: "Unsupported tool_choice value" } } },
      reply({ tool_calls: [call("a", "submit", { answers: ["x"], note: null })] }),
    ]);
    const result = await provider.runAgent({ system: "s", user: "u", tools: [], submit });
    expect(result.output).toEqual({ answers: ["x"], note: null });
    expect(requests.map((r) => r.tool_choice)).toEqual(["auto", "required", "auto"]);
  });

  it("nudges once when the model answers in text, then gives up", async () => {
    const { provider, requests } = fake([reply({ content: "Looks fine." }), reply({ content: "Still fine." })]);
    const result = await provider.runAgent({ system: "s", user: "u", tools: [], submit });
    expect(result.output).toBeNull();
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)).toEqual({ role: "user", content: expect.stringMatching(/^Call submit now/) });
  });

  it("offers only the submit tool on the last round", async () => {
    const root = gitRepo({ "a.ts": "x\n" });
    const { provider, requests } = fake([
      reply({ tool_calls: [call("a", "list_files", {})] }),
      reply({ tool_calls: [call("b", "submit", { answers: [], note: null })] }),
    ]);
    await provider.runAgent({ system: "s", user: "u", tools: repoToolList(root), submit, maxIterations: 2 });
    expect(requests[0].tools.length).toBe(5);
    expect(requests[1].tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(["submit"]);
    expect(requests[1].tool_choice).toBe("required");
  });

  it("retries rate-limited and server errors, but not client errors", async () => {
    const ok = reply({ tool_calls: [call("a", "submit", { answers: [], note: null })] });
    const limited = fake([{ status: 429, headers: { "retry-after": "0" }, body: {} }, { status: 503, body: {} }, ok]);
    expect((await limited.provider.runAgent({ system: "s", user: "u", tools: [], submit })).output).toEqual({
      answers: [],
      note: null,
    });
    expect(limited.requests).toHaveLength(3);

    const bad = fake([{ status: 400, body: { error: { message: "API key not valid" } } }]);
    await expect(bad.provider.runAgent({ system: "s", user: "u", tools: [], submit })).rejects.toThrow(
      /gemini API error 400: .*API key not valid/,
    );
  });
});

describe("createProvider", () => {
  it("prefers the free Gemini provider when its key is set", () => {
    expect(createProvider({ geminiApiKey: "g", anthropicApiKey: "a" })).toMatchObject({
      name: "gemini",
      model: "gemini-3.8-flash",
    });
    expect(createProvider({ anthropicApiKey: "a" })).toMatchObject({ name: "anthropic", model: "claude-opus-5-5" });
    expect(createProvider({ provider: "anthropic", geminiApiKey: "g", anthropicApiKey: "a" })?.name).toBe("anthropic");
    expect(createProvider({ provider: "gemini", anthropicApiKey: "a" })).toBeNull();
    expect(createProvider({ geminiApiKey: "g", model: "gemini-3.7-flash" })?.model).toBe("gemini-3.7-flash");
    expect(createProvider({})).toBeNull();
  });
});

const quotaBody = (delay: string) => ({
  error: { code: 429, message: `Quota exceeded for metric: free_tier_requests, limit: 20\nPlease retry in ${delay}.` },
});

describe("parseRetryDelayMs", () => {
  it("reads Gemini's retryDelay detail, its message text, or Retry-After", () => {
    expect(parseRetryDelayMs('{"details":[{"retryDelay": "34s"}]}', null)).toBe(34_000);
    expect(parseRetryDelayMs("Please retry in 18m5.02s.", null)).toBeCloseTo(1_085_020);
    expect(parseRetryDelayMs("Please retry in 1h2m.", null)).toBe(3_720_000);
    expect(parseRetryDelayMs("nothing", "7")).toBe(7000);
    expect(parseRetryDelayMs("nothing", null)).toBeNull();
  });
});

describe("free-tier quota handling", () => {
  const ok = reply({ tool_calls: [call("a", "submit", { answers: [], note: null })] });

  it("waits out a short rate limit on the same model", async () => {
    const { provider, requests } = fake([{ status: 429, body: quotaBody("0s") }, ok], ["gemini-backup"]);
    await provider.runAgent({ system: "s", user: "u", tools: [], submit });
    expect(requests.map((r) => r.model)).toEqual(["gemini-test", "gemini-test"]);
  });

  it("switches to the next model when a quota is used up or a model is missing, dropping thought signatures", async () => {
    const { provider, requests } = fake(
      [
        reply({ tool_calls: [call("a", "list_files", {})], extra_content: { signature: "sig" } }),
        { status: 429, body: quotaBody("18m5s") },
        { status: 404, body: { error: { message: "model not found" } } },
        ok,
      ],
      ["gemini-backup", "gemini-third"],
    );
    const root = gitRepo({ "a.ts": "x\n" });
    const result = await provider.runAgent({ system: "s", user: "u", tools: repoToolList(root), submit });
    expect(result.output).toEqual({ answers: [], note: null });
    expect(requests.map((r) => r.model)).toEqual(["gemini-test", "gemini-test", "gemini-backup", "gemini-third"]);
    expect(provider.model).toBe("gemini-third");
    expect(requests[3].messages[2].extra_content).toBeUndefined();
  });

  it("throws AiQuotaError with the reset time once every model's quota is used up", async () => {
    const { provider } = fake(
      [
        { status: 429, body: quotaBody("2h0m") },
        { status: 429, body: quotaBody("2h0m") },
      ],
      ["gemini-backup"],
    );
    const err = await provider.runAgent({ system: "s", user: "u", tools: [], submit }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiQuotaError);
    expect((err as Error).message).toMatch(
      /quota is used up on every model tried \(gemini-test, gemini-backup\)\. It resets in about 2 hour/,
    );
  });
});
