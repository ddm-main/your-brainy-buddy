import { supabase, type Task, type TaskInsert } from "./client";

export const tasks = {
  list: async (opts: { status?: Task["status"]; focus?: boolean; limit?: number } = {}) => {
    let q = supabase.from("tasks").select("*").order("created_at", { ascending: false });
    if (opts.status) q = q.eq("status", opts.status);
    if (opts.focus) q = q.eq("focus", true);
    if (opts.limit) q = q.limit(opts.limit);
    const { data, error } = await q;
    if (error) throw error;
    return data ?? [];
  },
  listOpen: async (limit = 50) => {
    const { data, error } = await supabase
      .from("tasks")
      .select("*")
      .neq("status", "done")
      .neq("status", "cancelled")
      .order("due_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  },
  focus: async (limit = 7) => {
    const { data, error } = await supabase
      .from("tasks")
      .select("*")
      .eq("focus", true)
      .neq("status", "done")
      .neq("status", "cancelled")
      .order("priority", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  },
  create: async (t: Partial<TaskInsert> & { title: string }) => {
    const { data, error } = await supabase.from("tasks").insert(t).select().single();
    if (error) throw error;
    return data;
  },
  setStatus: async (id: string, status: Task["status"]) => {
    const { error } = await supabase.from("tasks").update({ status }).eq("id", id);
    if (error) throw error;
  },
  setFocus: async (id: string, focus: boolean) => {
    const { error } = await supabase.from("tasks").update({ focus }).eq("id", id);
    if (error) throw error;
  },
  remove: async (id: string) => {
    const { error } = await supabase.from("tasks").delete().eq("id", id);
    if (error) throw error;
  },
};
