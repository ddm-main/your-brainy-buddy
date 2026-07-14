import { supabase, type Decision } from "./client";

export const decisions = {
  list: async (limit = 50) => {
    const { data, error } = await supabase
      .from("decisions")
      .select("*, projects(name)")
      .order("decided_on", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  },
  create: async (d: {
    title: string;
    decision_text: string;
    context?: string;
    rationale?: string;
    options_considered?: string;
    decided_on?: string;
    linked_project_id?: string | null;
  }) => {
    const { data, error } = await supabase.from("decisions").insert(d).select().single();
    if (error) throw error;
    return data;
  },
  update: async (id: string, patch: Partial<Decision>) => {
    const { error } = await supabase.from("decisions").update(patch).eq("id", id);
    if (error) throw error;
  },
  remove: async (id: string) => {
    const { error } = await supabase.from("decisions").delete().eq("id", id);
    if (error) throw error;
  },
};
