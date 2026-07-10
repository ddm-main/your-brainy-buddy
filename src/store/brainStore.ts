import { create } from "zustand";
import { persist } from "zustand/middleware";

export type BrainProvider = "gemini" | "openrouter";

export interface Brain {
  provider: BrainProvider;
  model: string;
  label: string;
}

export const BRAIN_PRESETS: Brain[] = [
  { provider: "gemini", model: "google/gemini-3-flash-preview", label: "Gemini 3 Flash" },
  { provider: "gemini", model: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { provider: "gemini", model: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { provider: "openrouter", model: "openai/gpt-5", label: "GPT-5 (OpenRouter)" },
  { provider: "openrouter", model: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
  { provider: "openrouter", model: "x-ai/grok-2", label: "Grok 2" },
];

interface BrainStore {
  provider: BrainProvider;
  model: string;
  setBrain: (b: { provider: BrainProvider; model: string }) => void;
}

export const useBrain = create<BrainStore>()(
  persist(
    (set) => ({
      provider: "gemini",
      model: "google/gemini-3-flash-preview",
      setBrain: ({ provider, model }) => set({ provider, model }),
    }),
    { name: "jarvis.brain" },
  ),
);

export function currentBrainLabel(provider: BrainProvider, model: string): string {
  const p = BRAIN_PRESETS.find((b) => b.provider === provider && b.model === model);
  return p?.label ?? model;
}