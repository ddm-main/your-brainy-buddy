// Selects an AI-SDK model based on the caller's brain preference.
// Falls back to Gemini via Lovable AI Gateway when OpenRouter isn't
// configured so a missing key never blocks Finance features.

import { createOpenAICompatible } from "npm:@ai-sdk/openai-compatible";
import { createLovableAiGatewayProvider } from "./ai-gateway.ts";

export type Brain = { provider?: "gemini" | "openrouter"; model?: string };

const DEFAULTS = {
  gemini: "google/gemini-2.5-flash",
  openrouter: "openai/gpt-5",
};

export function selectBrain(brain: Brain, initialRunId?: string) {
  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) throw new Error("LOVABLE_API_KEY not configured");
  const gateway = createLovableAiGatewayProvider(key, initialRunId);

  if (brain.provider === "openrouter") {
    const orKey = Deno.env.get("OPENROUTER_API_KEY");
    if (orKey) {
      const openrouter = createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        headers: {
          Authorization: `Bearer ${orKey}`,
          "HTTP-Referer": "https://jarvis.lovable.app",
          "X-Title": "JARVIS Finance",
        },
      });
      return {
        model: openrouter(brain.model ?? DEFAULTS.openrouter),
        provider: "openrouter" as const,
        modelId: brain.model ?? DEFAULTS.openrouter,
      };
    }
  }
  return {
    model: gateway(brain.model ?? DEFAULTS.gemini),
    provider: "gemini" as const,
    modelId: brain.model ?? DEFAULTS.gemini,
  };
}