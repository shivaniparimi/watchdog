import type Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

export interface AgentOptions<T extends z.ZodObject> {
  client: Anthropic;
  model: string;
  system: string;
  user: string;
  /** Exploration tools Claude may call as often as it needs. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tools have different input types, as in the SDK.
  tools: readonly BetaRunnableTool<any>[];
  /** The tool Claude calls once, at the end, with its answer. */
  submit: { name: string; description: string; schema: T };
  /** Cap on API requests in the loop. */
  maxIterations?: number;
  effort?: "low" | "medium" | "high";
}

export interface AgentResult<T> {
  output: T | null;
  /** Number of exploration tool calls made, for logging. */
  toolCalls: number;
}

/**
 * Let Claude explore with read-only tools, then collect its answer from a submit tool.
 * Forced tool use isn't available on current models, so the prompt asks for the submit call and,
 * if Claude stops without making it, one follow-up message asks again.
 */
export async function runAgent<T extends z.ZodObject>(options: AgentOptions<T>): Promise<AgentResult<z.infer<T>>> {
  let output: z.infer<T> | null = null;
  let toolCalls = 0;

  const submitTool = {
    ...betaZodTool({
      name: options.submit.name,
      description: options.submit.description,
      inputSchema: options.submit.schema,
      run: async (input) => {
        output = input as z.infer<T>;
        return "Recorded. You're done; reply with a one-line confirmation and no further tool calls.";
      },
    }),
    strict: true,
  };
  const counted = options.tools.map((tool) => ({
    ...tool,
    run: async (input: unknown, ctx?: unknown) => {
      toolCalls++;
      return (tool.run as (i: unknown, c?: unknown) => ReturnType<typeof tool.run>)(input, ctx);
    },
  }));

  const run = (messages: BetaMessageParam[]) =>
    options.client.beta.messages.toolRunner({
      model: options.model,
      max_tokens: 16000,
      max_iterations: options.maxIterations ?? 25,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: options.effort ?? "high" },
      // Top-level auto-caching caches the growing conversation, so each loop turn re-reads it cheaply.
      cache_control: { type: "ephemeral" },
      system: options.system,
      tools: [...counted, submitTool],
      messages,
    });

  const runner = run([{ role: "user", content: options.user }]);
  let final = await runner.runUntilDone();
  if (output === null && final.stop_reason !== "refusal") {
    // Continue the same conversation, appended to unchanged, with a nudge to submit.
    const history = [...runner.params.messages];
    if (history.at(-1)?.role !== "assistant") history.push({ role: "assistant", content: final.content });
    const nudge = `Call ${options.submit.name} now with your answer. Use an empty list if you found nothing.`;
    // If the iteration cap stopped the loop mid-call, those calls need results before anything else.
    const pending = final.content.filter((b) => b.type === "tool_use");
    history.push({
      role: "user",
      content: [
        ...pending.map((b) => ({
          type: "tool_result" as const,
          tool_use_id: b.id,
          content: "Not run: the exploration budget is used up.",
          is_error: true,
        })),
        { type: "text" as const, text: nudge },
      ],
    });
    final = await run(history).runUntilDone();
  }
  if (output === null)
    console.warn(`Claude finished without calling ${options.submit.name} (stop_reason: ${final.stop_reason}).`);
  return { output, toolCalls };
}
