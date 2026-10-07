import { z } from "zod";
import { AiQuotaError, nudge, type AgentRequest, type AgentResult, type AiProvider, type ToolDef } from "./types.js";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Messages are kept exactly as the API returns them, so provider-specific fields (like Gemini's thought signatures) round-trip. */
type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content?: string | null; tool_calls?: ToolCall[]; [extra: string]: unknown }
  | { role: "tool"; tool_call_id: string; content: string };

interface CompletionResponse {
  choices?: { message: Extract<Message, { role: "assistant" }>; finish_reason?: string }[];
}

/**
 * Convert a Zod schema to the JSON Schema subset Gemini's function declarations accept: no `$schema`,
 * `additionalProperties` or numeric bounds, and nullable fields written as `nullable: true`.
 */
export function toFunctionSchema(schema: z.ZodType): Record<string, unknown> {
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (node === null || typeof node !== "object") return node;
    const obj = { ...(node as Record<string, unknown>) };
    delete obj.$schema;
    delete obj.additionalProperties;
    delete obj.minimum;
    delete obj.maximum;

    const variants = (obj.anyOf ?? obj.oneOf) as Record<string, unknown>[] | undefined;
    if (variants?.length === 2 && variants.some((v) => v.type === "null")) {
      const other = variants.find((v) => v.type !== "null")!;
      delete obj.anyOf;
      delete obj.oneOf;
      return { ...(clean(other) as object), ...(clean(obj) as object), nullable: true };
    }
    // Zod writes nullable fields as `type: ["string", "null"]`.
    if (Array.isArray(obj.type) && obj.type.includes("null") && obj.type.length === 2) {
      obj.type = obj.type.find((t) => t !== "null");
      obj.nullable = true;
    }
    for (const [key, value] of Object.entries(obj)) obj[key] = clean(value);
    return obj;
  };
  return clean(z.toJSONSchema(schema)) as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface OpenAICompatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Models to switch to, in order, when the current one's quota runs out or it isn't available. */
  fallbackModels?: string[];
  fetch?: typeof fetch;
  /** Base delay for retrying rate-limited requests; tests set it to 0. */
  retryDelayMs?: number;
}

/** Longest wait for a rate limit to clear before switching models instead. */
const MAX_WAIT_MS = 60_000;

/**
 * How long the API says to wait, from Gemini's error body (`"retryDelay": "34s"` or
 * "Please retry in 18m5.02s") or a Retry-After header.
 */
export function parseRetryDelayMs(body: string, retryAfterHeader: string | null): number | null {
  const detail = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(body);
  if (detail) return Number(detail[1]) * 1000;
  const text = /retry in (?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?/i.exec(body);
  if (text && (text[1] || text[2] || text[3])) {
    return ((Number(text[1] ?? 0) * 60 + Number(text[2] ?? 0)) * 60 + Number(text[3] ?? 0)) * 1000;
  }
  const header = Number(retryAfterHeader);
  return Number.isFinite(header) && header > 0 ? header * 1000 : null;
}

function describeWait(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min >= 60
    ? `about ${Math.round(min / 60)} hour(s)`
    : min >= 1
      ? `about ${min} minute(s)`
      : `${Math.ceil(ms / 1000)}s`;
}

/**
 * Any provider with an OpenAI-compatible chat completions API that supports function calling.
 * Used for Gemini's free tier, where each model has its own small request quota: short rate limits
 * are waited out, and when a model's quota is used up the provider moves on to the next free model.
 */
export class OpenAICompatProvider implements AiProvider {
  readonly name = "gemini" as const;
  readonly reviewChars = 120_000;
  readonly maxIterations = 8;
  readonly maxProofs = 2;
  private readonly models: string[];
  private modelIndex = 0;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatOptions) {
    this.models = [options.model, ...(options.fallbackModels ?? []).filter((m) => m !== options.model)];
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** The model currently in use (it changes when a quota runs out). */
  get model(): string {
    return this.models[this.modelIndex]!;
  }

  /** Whether the API rejected `tool_choice: "required"`; then "auto" is used from that point on. */
  private requiredUnsupported = false;

  private async complete(
    messages: Message[],
    tools: ToolDef[],
    requireTool = false,
  ): Promise<Extract<Message, { role: "assistant" }>> {
    const toolDefs = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: toFunctionSchema(t.inputSchema) },
    }));
    const base = this.options.retryDelayMs ?? 2000;

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages,
          tools: toolDefs,
          tool_choice: requireTool && !this.requiredUnsupported ? "required" : "auto",
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as CompletionResponse;
        const message = data.choices?.[0]?.message;
        if (!message) throw new Error("The model returned no message.");
        return message;
      }

      const text = await res.text();
      const quota = res.status === 429;
      const unavailable = res.status === 404;
      if (res.status === 400 && requireTool && !this.requiredUnsupported && /tool_choice/i.test(text)) {
        this.requiredUnsupported = true;
        attempt = -1;
        continue;
      }
      if (!quota && !unavailable && res.status < 500) {
        throw new Error(`${this.name} API error ${res.status}: ${text.slice(0, 500)}`);
      }

      // A short rate limit (per minute) is worth waiting out on the same model.
      const wait = quota
        ? (parseRetryDelayMs(text, res.headers.get("retry-after")) ?? base * 2 ** attempt)
        : base * 2 ** attempt;
      if (!unavailable && wait <= MAX_WAIT_MS && attempt < 4) {
        console.warn(`${this.name} API ${res.status} on ${this.model}; retrying in ${Math.ceil(wait / 1000)}s.`);
        await sleep(wait);
        continue;
      }

      // Quota used up (or model unavailable): move on to the next free model.
      if (this.modelIndex + 1 < this.models.length) {
        const from = this.model;
        this.modelIndex++;
        console.warn(`${from} ${unavailable ? "isn't available" : "quota used up"}; switching to ${this.model}.`);
        // Thought signatures belong to the model that produced them, so drop them from the history.
        for (const m of messages) if (m.role === "assistant") delete m.extra_content;
        attempt = -1;
        continue;
      }
      if (quota)
        throw new AiQuotaError(
          `${this.name} free-tier quota is used up on every model tried (${this.models.join(", ")}). It resets in ${describeWait(wait)}.`,
          wait,
        );
      throw new Error(`${this.name} API error ${res.status}: ${text.slice(0, 500)}`);
    }
  }

  async runAgent<T extends z.ZodObject>(request: AgentRequest<T>): Promise<AgentResult<z.infer<T>>> {
    let output: z.infer<T> | null = null;
    let toolCalls = 0;
    let nudged = false;
    const submit: ToolDef = {
      name: request.submit.name,
      description: request.submit.description,
      inputSchema: request.submit.schema,
      run: async () => "",
    };
    const tools = [...request.tools, submit];
    const byName = new Map(tools.map((t) => [t.name, t]));
    const messages: Message[] = [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ];

    const limit = request.maxIterations ?? this.maxIterations;
    for (let i = 0; i < limit + 1 && output === null; i++) {
      // On the last round, or after a nudge, only the submit tool is offered and a call is required,
      // because some models otherwise answer in plain text and their findings would be lost.
      const final = i >= limit - 1 || nudged;
      const message = await this.complete(messages, final ? [submit] : tools, final);
      messages.push(message);

      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        if (nudged) break;
        messages.push({ role: "user", content: nudge(request.submit.name) });
        nudged = true;
        continue;
      }

      for (const call of calls) {
        const tool = byName.get(call.function.name);
        let result: string;
        let args: unknown;
        let validJson = true;
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          validJson = false;
        }
        const parsed = validJson ? tool?.inputSchema.safeParse(args) : undefined;
        if (!tool) {
          result = `Error: there is no tool named ${call.function.name}.`;
        } else if (!validJson) {
          result = `Error: the arguments for ${tool.name} are not valid JSON. Call it again with valid JSON arguments.`;
        } else if (!parsed?.success) {
          result = `Error: invalid arguments for ${tool.name}: ${parsed?.error.message}. Call it again with arguments matching its schema.`;
        } else if (tool === submit) {
          output = parsed.data as z.infer<T>;
          result = "Recorded.";
        } else {
          toolCalls++;
          result = await tool.run(parsed.data).catch((err: unknown) => `Error: ${String(err)}`);
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }

    if (output === null) console.warn(`${this.name} finished without calling ${request.submit.name}.`);
    return { output, toolCalls };
  }
}

/** Free-tier Gemini models, newest first. Each has its own quota, so running out on one moves to the next. */
export const GEMINI_FREE_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-2.5-flash",
];

export function geminiProvider(apiKey: string, model = GEMINI_DEFAULT_MODEL, fetchImpl?: typeof fetch) {
  return new OpenAICompatProvider({
    baseUrl: GEMINI_BASE_URL,
    apiKey,
    model,
    fallbackModels: GEMINI_FREE_MODELS,
    fetch: fetchImpl,
  });
}
