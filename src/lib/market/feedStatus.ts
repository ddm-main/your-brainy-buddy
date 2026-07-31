// Single source of truth for "is this feed healthy?".
//
// Before this module the navbar chip counted rows in market_surface_probes
// (16 raw surfaces) while Feed Routing counted ROUTED_FEEDS (21 app feeds) with
// completely different rules — so the header could say 10/16 while the panel
// said 14 live / 1 down. Both now call computeFeedRows(), so there is exactly
// one status per feed and exactly one tally.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  ROUTED_FEEDS, ROUTED_PROVIDER_LABEL,
  type RoutedFeed, type RoutedProvider,
} from "@/components/config/providers/feedCatalog";
import {
  bestBySurface, canonicalProviderId, freshKey, useFeedFreshness, useSurfaceProbes,
  type Freshness, type SurfaceHealth, type SurfaceProbe,
} from "./selftest";

export type Status = "LIVE" | "DELAYED" | "FALLBACK" | "DOWN" | "IDLE" | "NOT SET";

export const STATUS_TONE: Record<Status, "ok" | "warn" | "err" | "neutral" | "accent"> = {
  LIVE: "ok", DELAYED: "warn", FALLBACK: "accent", DOWN: "err", IDLE: "neutral", "NOT SET": "neutral",
};

export type PrefRow = { feed_id: string; provider: string | null; fallback_provider: string | null };
export type Heartbeat = {
  feed_id: string; provider: string; ok: boolean; latency_ms: number | null;
  detail: string | null; symbols: number | null; observed_at: string;
};

export type FeedRow = {
  f: RoutedFeed;
  status: Status;
  detail: string;
  servedBy: string;
  health: string;
  primaryProbe: string | null;
};

/** IST calendar date (YYYY-MM-DD) — the key used for holiday lookups. */
export function istDate(now = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * NSE cash session by the clock only: Mon–Fri 09:15–15:30 IST. Callers must
 * combine this with the holiday flag — a holiday looks like a normal weekday
 * to a clock-only check, which used to paint every live feed DOWN all day.
 */
export function nseClockOpen(now = new Date()): boolean {
  const ist = new Date(now.getTime() + 5.5 * 3_600_000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 555 && mins <= 930;
}

/** Today an NSE trading holiday? Cheap, cached for the session. */
export function useMarketHoliday() {
  return useQuery({
    queryKey: ["market", "holiday", istDate()],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("market_holidays")
        .select("holiday_date")
        .eq("exchange", "NSE")
        .eq("holiday_date", istDate())
        .limit(1);
      if (error) throw error;
      return (data ?? []).length > 0;
    },
    staleTime: 60 * 60_000,
  });
}

export function useFeedPrefs() {
  return useQuery({
    queryKey: ["market", "feed-prefs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("market_feed_prefs").select("feed_id, provider, fallback_provider");
      if (error) throw error;
      return (data ?? []) as PrefRow[];
    },
    staleTime: 60_000,
  });
}

export function useFeedHeartbeats() {
  return useQuery({
    queryKey: ["market", "feed-heartbeats"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("market_feed_heartbeat")
        .select("feed_id, provider, ok, latency_ms, detail, symbols, observed_at");
      if (error) throw error;
      return Object.fromEntries(((data ?? []) as Heartbeat[]).map((h) => [h.feed_id, h]));
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

/** Map the resolver's provider ids onto the probe's provider names. */
export function sameProvider(routed: RoutedProvider, used: string): boolean {
  const u = (used || "").toLowerCase();
  // "computed"/"cache" are local paths, not vendors — no canonical id exists.
  if (routed === "computed") return u.includes("computed") || u.includes("local") || u.includes("cache");
  return canonicalProviderId(routed) === canonicalProviderId(u);
}

export function providerLabelFromProbe(used: string): string {
  const u = (used || "").toLowerCase();
  if (u.includes("kotak")) return ROUTED_PROVIDER_LABEL.kotak;
  if (u.includes("yahoo")) return ROUTED_PROVIDER_LABEL.yahoo;
  if (u.includes("nse")) return ROUTED_PROVIDER_LABEL.nse;
  if (u.includes("fmp") || u.includes("modeling")) return ROUTED_PROVIDER_LABEL.fmp;
  if (u.includes("alpha")) return ROUTED_PROVIDER_LABEL.alpha;
  if (u.includes("cache")) return "Cache";
  return used || "provider";
}

export const agoLabel = (iso: string): string => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

export type StatusInputs = {
  surfaces: Record<string, SurfaceHealth>;
  /** Every fresh probe row keyed `surface|provider` — used for chain-aware verdicts. */
  bySurfaceProvider: Record<string, SurfaceProbe>;
  heartbeats: Record<string, Heartbeat>;
  freshness: Freshness;
  prefs: PrefRow[];
  sessionOpen: boolean;
};

/** Index probes by surface+canonical provider so a feed can ask "did MY chain answer?". */
export function indexProbes(rows: SurfaceProbe[]): Record<string, SurfaceProbe> {
  const out: Record<string, SurfaceProbe> = {};
  for (const r of rows) {
    const k = `${r.surface}|${canonicalProviderId(r.provider)}`;
    const cur = out[k];
    if (!cur || r.checked_at > cur.checked_at) out[k] = r;
  }
  return out;
}

function chainProbe(
  bySurfaceProvider: Record<string, SurfaceProbe>,
  surface: string | undefined,
  chain: RoutedProvider[],
): { provider: RoutedProvider; probe: SurfaceProbe } | null {
  if (!surface) return null;
  for (const p of chain) {
    const probe = bySurfaceProvider[`${surface}|${canonicalProviderId(p)}`];
    if (probe && probe.ok) return { provider: p, probe };
  }
  return null;
}

export function statusForFeed(f: RoutedFeed, i: StatusInputs): FeedRow {
  const pref = i.prefs.find((p) => p.feed_id === f.id);
  const pinned = pref?.provider && pref.provider !== "auto" ? (pref.provider as RoutedProvider) : undefined;
  const primary = pinned ?? f.chain[0];
  const chain = [pinned, pref?.fallback_provider as RoutedProvider | undefined, ...f.chain]
    .filter((p): p is RoutedProvider => Boolean(p))
    .filter((p, idx, a) => a.indexOf(p) === idx);

  const probe = f.surface ? i.surfaces[f.surface] : undefined;
  const hb = f.heartbeat ? i.heartbeats[f.heartbeat] : undefined;
  const ts = f.table ? i.freshness[freshKey(f.table)] : undefined;
  const ageMin = ts ? (Date.now() - new Date(ts).getTime()) / 60_000 : null;
  const stale = ageMin != null && f.freshMins != null && ageMin > f.freshMins;
  const seen = ts ? `last data ${new Date(ts).toLocaleString()}` : "no cached rows";
  const open = i.sessionOpen;
  const inSelectedChain = (answered: string) => chain.some((p) => sameProvider(p, answered));

  const primaryProbeLine = (): string | null => {
    const p = probe?.primary;
    if (!p) return null;
    const state = p.ok ? "ok" : p.state === "degraded" ? "degraded" : "failed";
    const lat = p.latency_ms != null ? ` · ${p.latency_ms}ms` : "";
    return `${ROUTED_PROVIDER_LABEL[primary]} probed ${agoLabel(p.checked_at)} — ${state}${lat}`;
  };
  const primaryProbe = primaryProbeLine();

  // 1) Heartbeat — who really answered the last live request.
  if (hb) {
    const hbAge = (Date.now() - new Date(hb.observed_at).getTime()) / 60_000;
    const label = providerLabelFromProbe(hb.provider);
    const health = `${label} · ${agoLabel(hb.observed_at)}${hb.latency_ms != null ? ` · ${hb.latency_ms}ms` : ""}`;
    const fresh = hbAge <= (f.sessionOnly && !open ? 60 * 24 * 4 : (f.freshMins ?? 30));
    if (!hb.ok) return { f, status: "DOWN", detail: hb.detail || `${label} returned nothing`, servedBy: label, health, primaryProbe };
    if (!fresh) {
      return f.sessionOnly && !open
        ? { f, status: "IDLE", detail: `Market closed — last served by ${label} ${agoLabel(hb.observed_at)}.`, servedBy: label, health, primaryProbe: null }
        : { f, status: "DELAYED", detail: `Last served ${agoLabel(hb.observed_at)} — older than this feed's ${f.freshMins}m window.`, servedBy: label, health, primaryProbe };
    }
    if (!sameProvider(primary, hb.provider) && !inSelectedChain(hb.provider)) {
      return {
        f, status: "FALLBACK",
        detail: `${ROUTED_PROVIDER_LABEL[primary]} did not answer — served by ${label}${hb.detail ? ` (${hb.detail})` : ""}.`,
        servedBy: label, health, primaryProbe,
      };
    }
    return {
      f, status: "LIVE",
      detail: `${label} served ${hb.symbols ?? 0} symbol(s) ${agoLabel(hb.observed_at)} — real-time, no cache in the path.`,
      servedBy: label, health, primaryProbe: null,
    };
  }

  // 2) Surface probe.
  if (probe) {
    const answered = probe.provider || "unknown";
    const providerLabel = providerLabelFromProbe(answered);
    const health = `probe ${probe.state} · ${agoLabel(probe.checked_at)}${probe.latency_ms != null ? ` · ${probe.latency_ms}ms` : ""}`;
    if (probe.state === "not_configured") {
      return { f, status: "NOT SET", detail: probe.detail || `${providerLabel} needs to be connected first`, servedBy: providerLabel, health, primaryProbe: null };
    }
    if (!probe.ok || probe.state === "failed") {
      if (f.sessionOnly && !open) {
        return { f, status: "IDLE", detail: `Market closed — ${probe.detail || "no live data outside session"}.`, servedBy: "—", health, primaryProbe: null };
      }
      // Chain-aware: a failing primary with a healthy provider further down the
      // chain (or fresh data in the destination table) is a FALLBACK, not an
      // outage — the app is still serving this feed.
      const alt = chainProbe(i.bySurfaceProvider, f.surface, chain.filter((p) => !sameProvider(p, answered)));
      if (alt) {
        return {
          f, status: "FALLBACK",
          detail: `${ROUTED_PROVIDER_LABEL[primary]} failed (${probe.detail ?? "no answer"}) — served by ${ROUTED_PROVIDER_LABEL[alt.provider]}.`,
          servedBy: ROUTED_PROVIDER_LABEL[alt.provider], health, primaryProbe,
        };
      }
      if (ts && !stale && f.chain.length > 1) {
        return { f, status: "FALLBACK", detail: `${ROUTED_PROVIDER_LABEL[primary]} probe failed — fallback data is fresh. ${seen}`, servedBy: "fallback", health, primaryProbe };
      }
      return { f, status: "DOWN", detail: probe.detail || "probe failed", servedBy: "—", health, primaryProbe };
    }
    if (!sameProvider(primary, answered) && !inSelectedChain(answered)) {
      return { f, status: "FALLBACK", detail: `${ROUTED_PROVIDER_LABEL[primary]} did not answer — served by ${providerLabel}. ${seen}`, servedBy: providerLabel, health, primaryProbe };
    }
    if (probe.state === "degraded" || (stale && !f.onDemand)) {
      if (f.sessionOnly && !open) {
        return { f, status: "IDLE", detail: `Market closed — ${seen}.`, servedBy: providerLabel, health, primaryProbe: null };
      }
      return { f, status: "DELAYED", detail: `${probe.detail} · ${seen}`, servedBy: providerLabel, health, primaryProbe: null };
    }
    return { f, status: "LIVE", detail: `${providerLabel} answered · ${seen}`, servedBy: providerLabel, health, primaryProbe: null };
  }

  // 3) Batch / reference feeds — table freshness is the honest signal.
  if (!f.table) return { f, status: "IDLE", detail: f.note ?? "No probe for this feed", servedBy: ROUTED_PROVIDER_LABEL[primary], health: "not probed", primaryProbe: null };
  if (!ts) return { f, status: "DOWN", detail: "never synced", servedBy: "—", health: "no data", primaryProbe: null };
  if (f.onDemand) {
    return { f, status: "IDLE", detail: `Syncs on demand — ${seen}.`, servedBy: ROUTED_PROVIDER_LABEL[primary], health: `cache · ${agoLabel(ts)}`, primaryProbe: null };
  }
  if (stale && f.sessionOnly && !open) {
    return { f, status: "IDLE", detail: `Market closed — ${seen}.`, servedBy: ROUTED_PROVIDER_LABEL[primary], health: `cache · ${agoLabel(ts)}`, primaryProbe: null };
  }
  return stale
    ? { f, status: "DELAYED", detail: seen, servedBy: ROUTED_PROVIDER_LABEL[primary], health: `cache · ${agoLabel(ts)}`, primaryProbe: null }
    : { f, status: "LIVE", detail: seen, servedBy: ROUTED_PROVIDER_LABEL[primary], health: `cache · ${agoLabel(ts)}`, primaryProbe: null };
}

export function computeFeedRows(i: StatusInputs): FeedRow[] {
  return ROUTED_FEEDS.map((f) => statusForFeed(f, i));
}

export type FeedTally = {
  total: number;
  /** Available feeds: LIVE + FALLBACK + intentional IDLE. */
  ok: number;
  live: number;
  delayed: number;
  fallback: number;
  down: number;
  idle: number;
  notSet: number;
  affected: string[];
};

/** Tally one explicit scope. IDLE is intentional availability, not an outage. */
export function tallyRows(rows: FeedRow[], scope: "platform" | "account" = "platform"): FeedTally {
  const scoped = rows.filter((r) => scope === "account" ? r.f.perUser : !r.f.perUser);
  const count = (s: Status) => scoped.filter((r) => r.status === s).length;
  const live = count("LIVE");
  const fallback = count("FALLBACK");
  const idle = count("IDLE");
  return {
    total: scoped.length,
    ok: live + fallback + idle,
    live,
    delayed: count("DELAYED"),
    fallback,
    down: count("DOWN"),
    idle,
    notSet: count("NOT SET"),
    affected: scoped.filter((r) => r.status === "DOWN" || r.status === "DELAYED" || r.status === "FALLBACK")
      .map((r) => r.f.label),
  };
}

/** Everything the panel and the navbar chip need, from one set of queries. */
export function useFeedStatus() {
  const { data: probeRows = [], isLoading: probesLoading } = useSurfaceProbes();
  const { data: freshness = {} } = useFeedFreshness();
  const { data: heartbeats = {} } = useFeedHeartbeats();
  const { data: prefs = [] } = useFeedPrefs();
  const { data: holiday = false } = useMarketHoliday();

  const sessionOpen = nseClockOpen() && !holiday;

  const rows = useMemo(() => computeFeedRows({
    surfaces: bestBySurface(probeRows),
    bySurfaceProvider: indexProbes(probeRows),
    heartbeats: heartbeats as Record<string, Heartbeat>,
    freshness,
    prefs,
    sessionOpen,
  }), [probeRows, heartbeats, freshness, prefs, sessionOpen]);

  const tally = useMemo(() => tallyRows(rows, "platform"), [rows]);
  const accountTally = useMemo(() => tallyRows(rows, "account"), [rows]);
  const newest = useMemo(
    () => probeRows.reduce<string | null>((acc, r) => (!acc || r.checked_at > acc ? r.checked_at : acc), null),
    [probeRows],
  );

  return { rows, tally, accountTally, prefs, sessionOpen, holiday, checkedAt: newest, loading: probesLoading && probeRows.length === 0 };
}
