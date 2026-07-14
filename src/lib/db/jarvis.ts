import { supabase, type JarvisAction } from "./client";

export const actions = {
  recent: async (limit = 8) => {
    const { data, error } = await supabase
      .from("jarvis_actions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  },
  log: async (
    action_type: string,
    command_text?: string,
    target_module?: string,
    status: JarvisAction["status"] = "success",
    output?: unknown,
  ) => {
    const { error } = await supabase.from("jarvis_actions").insert({
      action_type,
      command_text,
      target_module,
      status,
      output: (output as unknown) ?? null,
    });
    if (error) throw error;
  },
};

export const reminders = {
  list: async () =>
    (await supabase.from("jarvis_reminders").select("*").order("fire_at")).data ?? [],
  create: async (text: string, fire_at: string, linked_task_id?: string | null) => {
    const { data, error } = await supabase
      .from("jarvis_reminders")
      .insert({ text, fire_at, linked_task_id: linked_task_id ?? null })
      .select()
      .single();
    if (error) throw error;
    return data;
  },
};
