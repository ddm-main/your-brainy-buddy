import { create } from "zustand";
import { toUserError } from "@/lib/userError";

export type Toast = {
  id: string;
  message: string;
  kind?: "info" | "ok" | "warn" | "err";
};

interface UiStore {
  paletteOpen: boolean;
  setPalette: (v: boolean) => void;
  togglePalette: () => void;
  conversationOpen: boolean;
  openConversation: () => void;
  closeConversation: () => void;
  toasts: Toast[];
  push: (m: string, k?: Toast["kind"]) => void;
  dismiss: (id: string) => void;
}

export const useUi = create<UiStore>((set, get) => ({
  paletteOpen: false,
  setPalette: (v) => set({ paletteOpen: v }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  conversationOpen: false,
  openConversation: () => set({ conversationOpen: true }),
  closeConversation: () => set({ conversationOpen: false }),
  toasts: [],
  push: (message, kind = "info") => {
    const id = Math.random().toString(36).slice(2);
    // Defense in depth: sanitize error toasts so raw stack/URL/UUID leaks
    // can never reach the panel even if a caller forgot to.
    const safe = kind === "err" || kind === "warn"
      ? toUserError(message ?? "", "Something went wrong")
      : (message ?? "");
    set({ toasts: [...get().toasts, { id, message: safe, kind }] });
    setTimeout(() => get().dismiss(id), 4000);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));
