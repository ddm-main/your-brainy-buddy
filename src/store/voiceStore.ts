import { create } from "zustand";

export type VoiceState =
  | "idle"
  | "listening"
  | "processing"
  | "speaking"
  | "paused"
  | "muted";

export type VoiceLanguage = "en-IN" | "hi-IN" | "mr-IN";
export type VoiceStyleId =
  | "jarvis-british"
  | "warm-narrator"
  | "crisp-anchor"
  | "friendly-indian"
  | "whisper-calm";

export interface VoiceStyle {
  id: VoiceStyleId;
  label: string;
  voice: string;
  instructions: string;
}

export const VOICE_STYLES: Record<VoiceStyleId, VoiceStyle> = {
  "jarvis-british": {
    id: "jarvis-british",
    label: "JARVIS · British",
    voice: "onyx",
    instructions:
      "Speak as Iron Man's JARVIS: calm, precise, lightly witty. Refined British accent, low warm register, unhurried but crisp. Never dramatic.",
  },
  "warm-narrator": {
    id: "warm-narrator",
    label: "Warm Narrator",
    voice: "sage",
    instructions:
      "Speak like a warm documentary narrator: smooth, measured cadence, gentle emphasis, rich tone. Reassuring and articulate.",
  },
  "crisp-anchor": {
    id: "crisp-anchor",
    label: "Crisp Anchor",
    voice: "verse",
    instructions:
      "Speak with clean neutral American news-anchor clarity: brisk, confident, well-articulated, no filler.",
  },
  "friendly-indian": {
    id: "friendly-indian",
    label: "Friendly Indian",
    voice: "alloy",
    instructions:
      "Speak natural Indian English, conversational and friendly, medium pace, warm and helpful — like a competent colleague.",
  },
  "whisper-calm": {
    id: "whisper-calm",
    label: "Whisper Calm",
    voice: "shimmer",
    instructions:
      "Speak softly and slowly, hushed late-night tone, gentle breath, low volume, calming and intimate.",
  },
};

const LANG_KEY = "jarvis.lang";
const STYLE_KEY = "jarvis.voiceStyle";

function readLang(): VoiceLanguage {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v === "en-IN" || v === "hi-IN" || v === "mr-IN") return v;
  } catch { /* noop */ }
  return "en-IN";
}
function readStyle(): VoiceStyleId {
  try {
    const v = localStorage.getItem(STYLE_KEY);
    if (v && v in VOICE_STYLES) return v as VoiceStyleId;
  } catch { /* noop */ }
  return "jarvis-british";
}

interface VoiceStore {
  state: VoiceState;
  continuous: boolean;
  transcript: string;
  interim: string;
  lastAnswer: string;
  amplitude: number;
  showTranscript: boolean;
  visionBusy: boolean;
  lastActivity: number;
  error: string | null;
  language: VoiceLanguage;
  voiceStyle: VoiceStyleId;
  setError: (e: string | null) => void;
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
  setLanguage: (l: VoiceLanguage) => void;
  setVoiceStyle: (s: VoiceStyleId) => void;
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
  error: null,
  language: readLang(),
  voiceStyle: readStyle(),
  setError: (e) => set({ error: e }),
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
  setLanguage: (l) => {
    try { localStorage.setItem(LANG_KEY, l); } catch { /* noop */ }
    set({ language: l });
  },
  setVoiceStyle: (id) => {
    try { localStorage.setItem(STYLE_KEY, id); } catch { /* noop */ }
    set({ voiceStyle: id });
  },
}));
