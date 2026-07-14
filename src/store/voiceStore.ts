import { create } from "zustand";

export type VoiceState =
  | "idle"
  | "listening"
  | "processing"
  | "speaking"
  | "paused"
  | "muted";

interface VoiceStore {
  state: VoiceState;
  continuous: boolean;
  transcript: string;
  interim: string;
  lastAnswer: string;
  amplitude: number; // 0..1 driving core visuals
  showTranscript: boolean;
  visionBusy: boolean;
  lastActivity: number;
  setState: (s: VoiceState) => void;
  setTranscript: (t: string) => void;
  setInterim: (t: string) => void;
  setAnswer: (t: string) => void;
  setAmplitude: (a: number) => void;
  toggleContinuous: () => void;
  toggleTranscript: () => void;
  mute: () => void;
  reset: () => void;
  interrupt: () => void;
  setVisionBusy: (b: boolean) => void;
  markActivity: () => void;
}

export const useVoice = create<VoiceStore>((set) => ({
  state: "idle",
  continuous: true,
  transcript: "",
  interim: "",
  lastAnswer: "",
  amplitude: 0,
  showTranscript: false,
  visionBusy: false,
  lastActivity: Date.now(),
  setState: (s) => set({ state: s }),
  setTranscript: (t) => set({ transcript: t }),
  setInterim: (t) => set({ interim: t }),
  setAnswer: (t) => set({ lastAnswer: t }),
  setAmplitude: (a) => set({ amplitude: a }),
  toggleContinuous: () => set((s) => ({ continuous: !s.continuous })),
  toggleTranscript: () => set((s) => ({ showTranscript: !s.showTranscript })),
  mute: () => set({ state: "muted" }),
  reset: () => set({ state: "idle", interim: "", amplitude: 0 }),
  interrupt: () => {
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
    set((s) => ({
      state: s.continuous ? "listening" : "idle",
      interim: "",
      amplitude: 0,
      visionBusy: false,
    }));
  },
  setVisionBusy: (b) => set({ visionBusy: b }),
  markActivity: () => set({ lastActivity: Date.now() }),
}));
