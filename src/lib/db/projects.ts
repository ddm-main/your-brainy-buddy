import { supabase, type Project } from "./client";

export const projects = {
  list: async () => {
    const { data, error } = await supabase
      .from("projects")
      .select("*")
      .order("status", { ascending: true })
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return data ?? [];
  },
  get: async (id: string) => {
    const { data, error } = await supabase.from("projects").select("*").eq("id", id).single();
    if (error) throw error;
    return data;
  },
  getBySlug: async (slug: string) => {
    const { data } = await supabase.from("projects").select("*").eq("slug", slug).maybeSingle();
    return data ?? null;
  },
  create: async (p: {
    name: string;
    description?: string;
    slug?: string;
    status?: Project["status"];
  }) => {
    const { data, error } = await supabase.from("projects").insert(p).select().single();
    if (error) throw error;
    return data;
  },
  update: async (id: string, patch: Partial<Project>) => {
    const { error } = await supabase.from("projects").update(patch).eq("id", id);
    if (error) throw error;
  },
  addUpdate: async (project_id: string, update_text: string) => {
    const { data, error } = await supabase
      .from("project_updates")
      .insert({ project_id, update_text })
      .select()
      .single();
    if (error) throw error;
    return data;
  },
  updates: async (project_id: string, limit = 20) => {
    const { data, error } = await supabase
      .from("project_updates")
      .select("*")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  },
};
