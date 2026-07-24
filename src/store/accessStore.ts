import { create } from "zustand";
import { supabase } from "@/integrations/supabase/client";

export type AppSection = "hud" | "market" | "finance" | "tasks" | "projects" | "inbox" | "config";
export const ALL_SECTIONS: AppSection[] = ["hud", "market", "finance", "tasks", "projects", "inbox", "config"];

type State = {
  ready: boolean;
  role: "admin" | "user" | null;
  sections: Set<AppSection>;
  load: (userId: string | null) => Promise<void>;
  reset: () => void;
};

export const useAccessStore = create<State>((set) => ({
  ready: false,
  role: null,
  sections: new Set(),
  reset: () => set({ ready: false, role: null, sections: new Set() }),
  load: async (userId) => {
    if (!userId) { set({ ready: true, role: null, sections: new Set() }); return; }
    const [{ data: roles }, { data: access }] = await Promise.all([
      supabase.from("user_roles").select("role").eq("user_id", userId),
      supabase.from("user_page_access").select("section").eq("user_id", userId),
    ]);
    const isAdmin = (roles ?? []).some((r: { role: string }) => r.role === "admin");
    const sectionSet = new Set<AppSection>(
      (access ?? []).map((a: { section: string }) => a.section as AppSection),
    );
    set({ ready: true, role: isAdmin ? "admin" : "user", sections: sectionSet });
  },
}));

export function useAccess() {
  return useAccessStore();
}

export function hasSection(sections: Set<AppSection>, s: AppSection) {
  return sections.has(s);
}
