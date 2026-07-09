import { supabase } from "@/integrations/supabase/client";

export interface Reminder {
  id: string;
  text: string;
  fire_at: string;
  fired: boolean;
}

export async function fetchDueReminders(): Promise<Reminder[]> {
  const { data, error } = await supabase
    .from("jarvis_reminders")
    .select("id,text,fire_at,fired")
    .eq("fired", false)
    .lte("fire_at", new Date().toISOString())
    .order("fire_at");
  if (error) throw error;
  return (data ?? []) as Reminder[];
}

export async function markFired(id: string) {
  await supabase.from("jarvis_reminders").update({ fired: true }).eq("id", id);
}

export function startReminderPoller(onFire: (r: Reminder) => void) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const due = await fetchDueReminders();
      for (const r of due) {
        await markFired(r.id);
        onFire(r);
      }
    } catch { /* silent */ }
  };
  const iv = window.setInterval(tick, 30_000);
  tick();
  return () => { stopped = true; window.clearInterval(iv); };
}
