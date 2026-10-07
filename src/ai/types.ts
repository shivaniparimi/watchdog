import type { z } from "zod";

/** A tool Claude or Gemini can call: a name, a Zod input schema, and a function that returns text. */
export interface ToolDef<T extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  inputSchema: T;
  run: (input: z.infer<T>) => Promise<string>;
}

export interface AgentRequest<T extends z.ZodObject> {
  system: string;
  user: string;
  /** Read-only tools the model may call as often as it needs. */
  tools: readonly ToolDef[];
  /** The tool the model calls once, at the end, with its answer. */
  submit: { name: string; description: string; schema: T };
  /** Cap on API requests in the loop. */
  maxIterations?: number;
  effort?: "low" | "medium" | "high";
}

export interface AgentResult<T> {
  output: T | null;
  /** Number of exploration tool calls made, for reporting. */
  toolCalls: number;
}

/** A model provider. Every AI step in Watchdog is "explore with tools, then submit an answer". */
export interface AiProvider {
  readonly name: "anthropic" | "gemini";
  readonly model: string;
  /** Prompt budget (characters of diff and file content) suited to this provider's limits. */
  readonly reviewChars: number;
  /** Default cap on exploration round trips, suited to this provider's rate limits. */
  readonly maxIterations: number;
  /** Default number of findings to prove with tests (each proof costs several requests). */
  readonly maxProofs: number;
  runAgent<T extends z.ZodObject>(request: AgentRequest<T>): Promise<AgentResult<z.infer<T>>>;
}

export function nudge(submitName: string): string {
  return `Call ${submitName} now with your answer. Use an empty list if you found nothing.`;
}

/** The provider's request quota is used up (e.g. a free tier's daily limit); AI steps should be skipped, not fail the PR. */
export class AiQuotaError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "AiQuotaError";
  }
}
