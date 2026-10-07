import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_DEFAULT_MODEL, AnthropicProvider } from "./anthropic.js";
import { GEMINI_DEFAULT_MODEL, geminiProvider } from "./openaiCompat.js";
import type { AiProvider } from "./types.js";

export { AiQuotaError } from "./types.js";
export type { AiProvider, AgentRequest, AgentResult, ToolDef } from "./types.js";

export interface ProviderConfig {
  /** "auto" picks Gemini when a Gemini key is set, else Claude when an Anthropic key is set. */
  provider?: "auto" | "gemini" | "anthropic";
  geminiApiKey?: string;
  anthropicApiKey?: string;
  /** Model override; each provider has its own default. */
  model?: string;
}

/** Build the configured AI provider, or null when there's no key for it (AI steps are then skipped). */
export function createProvider(config: ProviderConfig): AiProvider | null {
  const choice = config.provider ?? "auto";
  const useGemini = choice === "gemini" || (choice === "auto" && !!config.geminiApiKey);
  const useAnthropic =
    choice === "anthropic" || (choice === "auto" && !config.geminiApiKey && !!config.anthropicApiKey);

  if (useGemini) {
    if (!config.geminiApiKey) return null;
    return geminiProvider(config.geminiApiKey, config.model || GEMINI_DEFAULT_MODEL);
  }
  if (useAnthropic) {
    if (!config.anthropicApiKey) return null;
    return new AnthropicProvider(
      new Anthropic({ apiKey: config.anthropicApiKey }),
      config.model || ANTHROPIC_DEFAULT_MODEL,
    );
  }
  return null;
}
