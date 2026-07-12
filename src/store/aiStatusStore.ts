import { create } from "zustand";

// Reflects the real outcome of the most recent jarvis-chat call — updated by
// jarvisChat() itself on success/failure. Starts optimistic (true) since we
// haven't made a call yet and don't want to show red before anything's run.
interface AiStatusStore {
  ok: boolean;
  lastCheckedAt: string | null;
  setOk: (ok: boolean) => void;
}

export const useAiStatus = create<AiStatusStore>((set) => ({
  ok: true,
  lastCheckedAt: null,
  setOk: (ok) => set({ ok, lastCheckedAt: new Date().toISOString() }),
}));
