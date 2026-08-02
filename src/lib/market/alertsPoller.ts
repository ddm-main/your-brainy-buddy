// Client-side delivery for market alerts — mirrors src/lib/reminders.ts's
// startReminderPoller pattern. market_alert_events only has owner-scoped
// SELECT/INSERT grants (no UPDATE), so "already notified" is tracked
// client-side via localStorage rather than a server-side flag.
import { supabase } from "@/integrations/supabase/client";
import { nseOpenNow } from "./liveTickStore";

export interface AlertEvent {
  id: string;
  symbol: string;
  exchange: string;
  trigger_value: number | null;
  triggered_at: string;
  meta: { type?: string; threshold?: number } | null;
}

const LAST_SEEN_KEY = "jarvis.market.alertsPoller.lastSeenAt";

function getLastSeen(): string {
  return localStorage.getItem(LAST_SEEN_KEY) ?? new Date(Date.now() - 60_000).toISOString();
}

function setLastSeen(iso: string) {
  localStorage.setItem(LAST_SEEN_KEY, iso);
}

export async function fetchNewAlertEvents(): Promise<AlertEvent[]> {
  const since = getLastSeen();
  const { data, error } = await supabase
    .from("market_alert_events")
    .select("id,symbol,exchange,trigger_value,triggered_at,meta")
    .gt("triggered_at", since)
    .order("triggered_at", { ascending: true })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as AlertEvent[];
}

const TYPE_LABELS: Record<string, string> = {
  price_above: "price above",
  price_below: "price below",
  percent_change: "% move",
  rsi_above: "RSI above",
  rsi_below: "RSI below",
  ema_cross_up: "EMA cross",
  breakout: "breakout",
};

export function formatAlertEvent(e: AlertEvent): string {
  const label = TYPE_LABELS[e.meta?.type ?? ""] ?? e.meta?.type ?? "alert";
  const val = e.trigger_value != null ? ` (${e.trigger_value.toFixed(2)})` : "";
  return `${e.symbol}: ${label}${val}`;
}

// After DEGRADED_AFTER consecutive tick failures the poller surfaces a
// degraded state through onStatus so the UI can show a small "alerts
// degraded" banner. Failures were previously swallowed silently (matching
// the reminders poller), which meant a Supabase outage or network issue
// left alerts quietly dead until the tab was reloaded.
const DEGRADED_AFTER = 3;

export type AlertsPollerStatus = "ok" | "degraded";

export function startMarketAlertsPoller(
  onFire: (e: AlertEvent) => void,
  onStatus?: (status: AlertsPollerStatus, lastError?: string) => void,
) {
  let stopped = false;
  let consecutiveFailures = 0;
  let lastStatus: AlertsPollerStatus = "ok";
  const setStatus = (next: AlertsPollerStatus, err?: string) => {
    if (next === lastStatus) return;
    lastStatus = next;
    onStatus?.(next, err);
  };
  const tick = async () => {
    if (stopped) return;
    // EGRESS: alerts only fire on price movement, and a hidden tab can't show
    // the toast anyway — so poll only while visible, and slowly once NSE closes.
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    try {
      const events = await fetchNewAlertEvents();
      consecutiveFailures = 0;
      setStatus("ok");
      if (events.length === 0) return;
      for (const e of events) onFire(e);
      setLastSeen(events[events.length - 1].triggered_at);
    } catch (e) {
      consecutiveFailures++;
      if (consecutiveFailures >= DEGRADED_AFTER) {
        setStatus("degraded", e instanceof Error ? e.message : String(e));
      }
    }
  };
  let iv = window.setInterval(tick, nseOpenNow() ? 30_000 : 5 * 60_000);
  // Re-arm the timer when the session flips so the cadence matches the market.
  const rearm = window.setInterval(() => {
    window.clearInterval(iv);
    iv = window.setInterval(tick, nseOpenNow() ? 30_000 : 5 * 60_000);
  }, 10 * 60_000);
  const onVis = () => { if (document.visibilityState === "visible") tick(); };
  document.addEventListener("visibilitychange", onVis);
  tick();
  return () => {
    stopped = true;
    window.clearInterval(iv);
    window.clearInterval(rearm);
    document.removeEventListener("visibilitychange", onVis);
  };
}
