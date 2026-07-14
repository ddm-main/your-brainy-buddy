import { supabase as _supabase } from "@/integrations/supabase/client";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = _supabase as any;

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

// Cross-tab singleton: only the tab that holds the leader lock polls.
// Other tabs receive fires over BroadcastChannel and just render/speak once.
const LOCK_KEY = "jarvis.reminder.leader";
const LOCK_TTL_MS = 15_000;
const TICK_MS = 30_000;

function claimLeader(id: string): boolean {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    const now = Date.now();
    if (raw) {
      const { id: holder, exp } = JSON.parse(raw) as { id: string; exp: number };
      if (holder !== id && exp > now) return false;
    }
    localStorage.setItem(LOCK_KEY, JSON.stringify({ id, exp: now + LOCK_TTL_MS }));
    return true;
  } catch { return false; }
}

export function startReminderPoller(onFire: (r: Reminder) => void) {
  let stopped = false;
  const tabId = Math.random().toString(36).slice(2);
  const bc = "BroadcastChannel" in window ? new BroadcastChannel("jarvis-reminders") : null;

  if (bc) bc.onmessage = (ev) => {
    if (stopped) return;
    const r = ev.data as Reminder | null;
    if (r && r.id) onFire(r);
  };

  const tick = async () => {
    if (stopped) return;
    if (!claimLeader(tabId)) return;              // another tab is leading
    try {
      const due = await fetchDueReminders();
      for (const r of due) {
        await markFired(r.id);
        onFire(r);
        bc?.postMessage(r);
      }
    } catch { /* silent */ }
  };
  const iv = window.setInterval(tick, TICK_MS);
  tick();
  return () => { stopped = true; window.clearInterval(iv); bc?.close(); };
}
