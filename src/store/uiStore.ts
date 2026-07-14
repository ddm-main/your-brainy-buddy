import { create } from "zustand";

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
    set({ toasts: [...get().toasts, { id, message, kind }] });
    setTimeout(() => get().dismiss(id), 4000);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));
