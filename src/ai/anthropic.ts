import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { z } from "zod";
import { nudge, type AgentRequest, type AgentResult, type AiProvider } from "./types.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic" as const;
  readonly reviewChars = 400_000;
  readonly maxIterations = 30;
  readonly maxProofs = 5;

  constructor(
    private readonly client: Anthropic,
    readonly model: string = ANTHROPIC_DEFAULT_MODEL,
  ) {}

  /**
   * Let Claude explore with tools, then collect its answer from a submit tool. Forced tool use isn't
   * available on current models, so the prompt asks for the submit call and, if Claude stops
   * without making it, one follow-up message asks again.
   */
  async runAgent<T extends z.ZodObject>(request: AgentRequest<T>): Promise<AgentResult<z.infer<T>>> {
    let output: z.infer<T> | null = null;
    let toolCalls = 0;

    const submitTool = {
      ...betaZodTool({
        name: request.submit.name,
        description: request.submit.description,
        inputSchema: request.submit.schema,
        run: async (input) => {
          output = input as z.infer<T>;
          return "Recorded. You're done; reply with a one-line confirmation and no further tool calls.";
        },
      }),
      strict: true,
    };
    const tools = request.tools.map((tool) =>
      betaZodTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        run: async (input) => {
          toolCalls++;
          return tool.run(input);
        },
      }),
    );

    const run = (messages: BetaMessageParam[]) =>
      this.client.beta.messages.toolRunner({
        model: this.model,
        max_tokens: 16000,
        max_iterations: request.maxIterations ?? this.maxIterations,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: request.effort ?? "high" },
        // Top-level auto-caching caches the growing conversation, so each loop turn re-reads it cheaply.
        cache_control: { type: "ephemeral" },
        system: request.system,
        tools: [...tools, submitTool],
        messages,
      });

    const runner = run([{ role: "user", content: request.user }]);
    let final = await runner.runUntilDone();
    if (output === null && final.stop_reason !== "refusal") {
      // Continue the same conversation, appended to unchanged, with a nudge to submit.
      const history = [...runner.params.messages];
      if (history.at(-1)?.role !== "assistant") history.push({ role: "assistant", content: final.content });
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
          { type: "text" as const, text: nudge(request.submit.name) },
        ],
      });
      final = await run(history).runUntilDone();
    }
    if (output === null) {
      console.warn(`Claude finished without calling ${request.submit.name} (stop_reason: ${final.stop_reason}).`);
    }
    return { output, toolCalls };
  }
}
