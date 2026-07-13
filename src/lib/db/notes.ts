import { supabase, type Note } from "./client";

export const notes = {
  list: async (limit = 100) => {
    const { data, error } = await supabase
      .from("notes")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  },
  create: async (n: {
    title: string;
    content?: string;
    note_type?: Note["note_type"];
    linked_project_id?: string | null;
  }) => {
    const { data, error } = await supabase.from("notes").insert(n).select().single();
    if (error) throw error;
    return data;
  },
  update: async (id: string, patch: Partial<Note>) => {
    const { error } = await supabase.from("notes").update(patch).eq("id", id);
    if (error) throw error;
  },
  remove: async (id: string) => {
    const { error } = await supabase.from("notes").delete().eq("id", id);
    if (error) throw error;
  },
};
