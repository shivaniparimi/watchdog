import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { AnalyzedSymbol, Verdict } from "./types.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
const BATCH_SIZE = 6;

const VerdictsSchema = z.object({
  verdicts: z.array(
    z.object({
      id: z.string(),
      covered: z.boolean(),
      risk: z.enum(["high", "medium", "low", "none"]),
      reason: z.string(),
      suggested_test: z.string(),
    }),
  ),
});

// Kept byte-identical across calls so prompt caching can reuse it.
const SYSTEM_PROMPT = `You review pull requests for test gaps: changed behavior that no test exercises.

For each changed function you get its diff (lines marked "+" were added, "-" removed, "L<n>" is the line number in the new file), its full new body, and excerpts from test files that mention it ("changed in this PR" marks tests the author touched).

Decide for each function:
- covered: true only if the provided tests clearly exercise the specific behavior that changed (the new branch, condition, return value, or error path). A test that merely calls the function while ignoring the changed path does not count. If no test excerpts are given, covered is false.
- risk: how much an untested change here could hurt.
  - "high": business logic, money, auth/permissions, data writes or deletion, parsing untrusted input, concurrency, or a new error path.
  - "medium": ordinary logic changes such as new branches, changed conditions, or changed return values.
  - "low": small or low-impact logic changes.
  - "none": no test needed, e.g. a rename, pure refactor with identical behavior, type-only change, or trivial passthrough. Use "none" when covered is true.
- reason: one sentence naming the exact untested behavior, or why it is covered or needs no test. Refer to code, not to these instructions.
- suggested_test: when covered is false and risk is not "none", a short test in the repository's existing test style (match the framework and naming seen in the excerpts). Otherwise an empty string.

Return one verdict per function, using the id given for each.`;

function renderItem(sym: AnalyzedSymbol): string {
  const tests =
    sym.evidence.length === 0
      ? "No test file mentions this function."
      : sym.evidence
          .map((e) => `--- ${e.path}${e.changedInPr ? " (changed in this PR)" : ""}\n${e.excerpt}`)
          .join("\n\n");
  return `<function id="${sym.id}">
File: ${sym.path} (${sym.language})
Function: ${sym.name}${sym.isNew ? " (new in this PR)" : ""}

Diff:
${sym.diffSnippet}

Full body:
${sym.body}

Tests:
${tests}
</function>`;
}

export interface JudgeOptions {
  client?: Anthropic;
  model?: string;
}

/** Ask Claude whether each function's changed behavior is tested. Returns verdicts keyed by symbol id. */
export async function judge(symbols: AnalyzedSymbol[], options: JudgeOptions = {}): Promise<Map<string, Verdict>> {
  const client = options.client ?? new Anthropic();
  const model = options.model ?? DEFAULT_MODEL;
  const verdicts = new Map<string, Verdict>();

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: betaZodOutputFormat(VerdictsSchema) },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: batch.map(renderItem).join("\n\n") }],
    });

    if (response.stop_reason === "refusal" || !response.parsed_output) {
      console.warn(`Claude returned no verdicts for ${batch.length} function(s) (stop_reason: ${response.stop_reason}).`);
      continue;
    }

    const ids = new Set(batch.map((s) => s.id));
    for (const v of response.parsed_output.verdicts) {
      if (!ids.has(v.id)) continue;
      verdicts.set(v.id, {
        covered: v.covered,
        risk: v.covered ? "none" : v.risk,
        reason: v.reason,
        suggestedTest: v.suggested_test,
        source: "ai",
      });
    }
  }

  return verdicts;
}
