import { z } from "zod";
import { nudge, type AgentRequest, type AgentResult, type AiProvider, type ToolDef } from "./types.js";

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
  fetch?: typeof fetch;
  /** Base delay for retrying rate-limited requests; tests set it to 0. */
  retryDelayMs?: number;
}

/**
 * Any provider with an OpenAI-compatible chat completions API that supports function calling.
 * Used for Gemini's free tier: requests are retried with backoff when rate-limited, and prompt
 * budgets are kept small to stay inside free-tier token limits.
 */
export class OpenAICompatProvider implements AiProvider {
  readonly name = "gemini" as const;
  readonly reviewChars = 150_000;
  readonly maxIterations = 12;
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatOptions) {
    this.model = options.model;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async complete(messages: Message[], tools: ToolDef[]): Promise<Extract<Message, { role: "assistant" }>> {
    const body = JSON.stringify({
      model: this.model,
      messages,
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: toFunctionSchema(t.inputSchema) },
      })),
      tool_choice: "auto",
    });

    const base = this.options.retryDelayMs ?? 2000;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
        body,
      });
      if (res.ok) {
        const data = (await res.json()) as CompletionResponse;
        const message = data.choices?.[0]?.message;
        if (!message) throw new Error("The model returned no message.");
        return message;
      }
      // Free tiers are rate-limited per minute: wait and retry, honoring Retry-After when given.
      const retryable = res.status === 429 || res.status >= 500;
      const text = await res.text();
      if (!retryable || attempt >= 5) throw new Error(`${this.name} API error ${res.status}: ${text.slice(0, 500)}`);
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : base * 2 ** attempt;
      console.warn(`${this.name} API ${res.status}; retrying in ${Math.round(wait / 1000)}s.`);
      await sleep(Math.min(wait, 90_000));
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
      // On the last round, only the submit tool is offered so the model has to answer.
      const offered = i >= limit - 1 ? [submit] : tools;
      const message = await this.complete(messages, offered);
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

export function geminiProvider(apiKey: string, model = GEMINI_DEFAULT_MODEL, fetchImpl?: typeof fetch) {
  return new OpenAICompatProvider({ baseUrl: GEMINI_BASE_URL, apiKey, model, fetch: fetchImpl });
}
