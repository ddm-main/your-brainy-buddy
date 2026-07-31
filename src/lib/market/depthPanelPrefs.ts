// Whether the A2 Market Depth ladder is shown. Persisted so the choice
// survives reloads, and lifted out of the component so the page owning the
// REST `useDepth` query can stop polling entirely while the panel is hidden.
import { create } from "zustand";
import { safeStorage } from "@/lib/safeStorage";

const KEY = "market.depth.visible";

interface DepthPanelState {
  visible: boolean;
  setVisible: (v: boolean) => void;
  toggle: () => void;
}

export const useDepthPanelStore = create<DepthPanelState>((set, get) => ({
  visible: safeStorage.get(KEY) !== "0",
  setVisible: (visible) => {
    safeStorage.set(KEY, visible ? "1" : "0");
    set({ visible });
  },
  toggle: () => get().setVisible(!get().visible),
}));

export const useDepthPanelVisible = () => useDepthPanelStore((s) => s.visible);
