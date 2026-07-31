// Feed Routing — every feed the app consumes, grouped, with a live status
// pill, the provider chain in effect, and separate Primary / Fallback
// selectors. Preferences live in market_feed_prefs (per user, RLS-scoped);
// the edge resolver builds the chain as primary → fallback → built-in chain.
//
// Status is derived from two honest signals:
//   • the live surface probe (market-test-connection, mode "surfaces") —
//     who actually answered, and did they answer at all;
//   • the freshness of the table the feed lands in.
// Feeds with neither (write paths) report IDLE rather than pretending.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { useRunSelfTest, useSurfaceProbes, bestBySurface, useFeedFreshness, freshKey, useProviderStats24h, canonicalProviderId, SELFTEST_QUERY_KEY } from "@/lib/market/selftest";
import {
  ROUTED_FEEDS, ROUTED_PROVIDER_LABEL, FEED_GROUP_LABEL,
  type RoutedProvider, type RoutedFeed, type FeedGroup,
} from "./feedCatalog";

const cell: React.CSSProperties = { padding: "5px 8px", verticalAlign: "middle", borderBottom: "1px solid var(--edge)" };
const head: React.CSSProperties = {
  ...cell, fontFamily: "var(--font-hud)", fontSize: 9, letterSpacing: "0.14em",
  textTransform: "uppercase", color: "var(--text-muted)", textAlign: "left",
};
const sel: React.CSSProperties = {
  background: "var(--bg)", color: "var(--text)", fontSize: 10,
  fontFamily: "var(--font-hud)", letterSpacing: "0.08em",
  border: "1px solid var(--edge-strong)", padding: "4px 6px", minWidth: 132,
};

type PrefRow = { feed_id: string; provider: string | null; fallback_provider: string | null };
type SurfaceResult = { ok: boolean; state: "ok" | "degraded" | "failed" | "not_configured"; provider_used: string; detail: string; checked_at: string };
type Heartbeat = { feed_id: string; provider: string; ok: boolean; latency_ms: number | null; detail: string | null; symbols: number | null; observed_at: string };
// NOT SET = the route needs credentials nobody has entered yet. Distinct from
// DOWN so an unconnected broker stops painting the panel red.
type Status = "LIVE" | "DELAYED" | "FALLBACK" | "DOWN" | "IDLE" | "NOT SET";

const STATUS_TONE: Record<Status, "ok" | "warn" | "err" | "neutral" | "accent"> = {
  LIVE: "ok", DELAYED: "warn", FALLBACK: "accent", DOWN: "err", IDLE: "neutral", "NOT SET": "neutral",
};

/** NSE cash session, Mon–Fri 09:15–15:30 IST — used so a quiet feed after
 *  the close reads as IDLE rather than DOWN. */
function nseSessionOpen(now = new Date()): boolean {
  const ist = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60_000);
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 555 && mins <= 930;
}

/** Map the resolver's provider ids onto the probe's provider names. */
function sameProvider(routed: RoutedProvider, used: string): boolean {
  const u = (used || "").toLowerCase();
  // "computed"/"cache" never reach the canonical id map — they are local
  // paths, not vendors, so they keep a substring check.
  if (routed === "computed") return u.includes("computed") || u.includes("local") || u.includes("cache");
  // Everything else goes through the single canonical id used server-side, so
  // "kotak" vs "kotak_neo" and "alpha" vs "alpha_vantage" can no longer read
  // as two different providers and mislabel a healthy primary as a fallback.
  return canonicalProviderId(routed) === canonicalProviderId(u);
}

function providerLabelFromProbe(used: string): string {
  const u = (used || "").toLowerCase();
  if (u.includes("kotak")) return ROUTED_PROVIDER_LABEL.kotak;
  if (u.includes("yahoo")) return ROUTED_PROVIDER_LABEL.yahoo;
  if (u.includes("nse")) return ROUTED_PROVIDER_LABEL.nse;
  if (u.includes("fmp")) return ROUTED_PROVIDER_LABEL.fmp;
  if (u.includes("alpha")) return ROUTED_PROVIDER_LABEL.alpha;
  if (u.includes("cache")) return "Cache";
  return used || "provider";
}

const agoLabel = (iso: string): string => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

export default function FeedRoutingPanel() {
  const qc = useQueryClient();
  const push = useUi((s) => s.push);
  const selfTest = useRunSelfTest();

  const { data: prefs = [] } = useQuery({
    queryKey: ["market", "feed-prefs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("market_feed_prefs").select("feed_id, provider, fallback_provider");
      if (error) throw error;
      return (data ?? []) as PrefRow[];
    },
    staleTime: 60_000,
  });

  // Freshness of every table a feed lands in — one RPC for all of them, and
  // one shared query key/shape so this panel and Provider Detail cannot
  // poison each other's cache (they previously stored different shapes here).
  const { data: freshness = {} } = useFeedFreshness();

  // Stored probe results, written by market-selftest (manual "test
  // everything" + the pg_cron schedule). Reading them instead of probing on
  // mount means status is correct the moment the page opens and survives a
  // reload; the button below refreshes them for every provider at once.
  const { data: probeRows = [] } = useSurfaceProbes();
  const surfaces = useMemo(() => bestBySurface(probeRows), [probeRows]);
  const { data: providerStats = {} } = useProviderStats24h();

  // Who actually served each live feed, most recently. Written by the serving
  // edge functions themselves, so this is the one signal that cannot lie
  // about liveness the way a batch-written cache table did.
  const { data: heartbeats = {} } = useQuery({
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

  const prefFor = (feedId: string) => prefs.find((p) => p.feed_id === feedId);

  const save = useMutation({
    mutationFn: async ({ feedId, primary, fallback }: { feedId: string; primary: string; fallback: string }) => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) throw new Error("Not signed in");
      if (primary === "auto" && fallback === "auto") {
        const { error } = await supabase.from("market_feed_prefs")
          .delete().eq("feed_id", feedId).eq("user_id", uid);
        if (error) throw error;
        return;
      }
      const { error } = await supabase.from("market_feed_prefs").upsert(
        {
          user_id: uid, feed_id: feedId,
          provider: primary,
          fallback_provider: fallback === "auto" ? null : fallback,
        } as never,
        { onConflict: "user_id,feed_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["market", "feed-prefs"] });
      push("Feed routing updated", "ok");
    },
    onError: (e) => push(toSafeError(e, "Could not save feed routing").message, "err"),
  });

  type Row = { status: Status; detail: string; servedBy: string; health: string; primaryProbe: string | null };

  /** Compact "primary probed X ago · Yms" line for FALLBACK / DOWN rows —
   *  the missing signal from the old UI: "when did we last try the primary?" */
  const primaryProbeLine = (f: RoutedFeed, primary: RoutedProvider): string | null => {
    const s = f.surface ? surfaces[f.surface] : undefined;
    const p = s?.primary;
    if (!p) return null;
    const label = ROUTED_PROVIDER_LABEL[primary];
    const state = p.ok ? "ok" : (p.state === "degraded" ? "degraded" : "failed");
    const lat = p.latency_ms != null ? ` · ${p.latency_ms}ms` : "";
    return `${label} probed ${agoLabel(p.checked_at)} — ${state}${lat}`;
  };

  const statusFor = (f: RoutedFeed): Row => {
    const pref = prefFor(f.id);
    const pinned = pref?.provider && pref.provider !== "auto" ? (pref.provider as RoutedProvider) : undefined;
    const primary = pinned ?? f.chain[0];
    const probe = f.surface ? surfaces[f.surface] : undefined;
    const hb = f.heartbeat ? (heartbeats as Record<string, Heartbeat>)[f.heartbeat] : undefined;
    const ts = f.table ? freshness[freshKey(f.table)] : undefined;
    const ageMin = ts ? (Date.now() - new Date(ts).getTime()) / 60_000 : null;
    const stale = ageMin != null && f.freshMins != null && ageMin > f.freshMins;
    const seen = ts ? `last data ${new Date(ts).toLocaleString()}` : "no cached rows";
    const open = nseSessionOpen();
    const selectedChain = [primary, pref?.fallback_provider as RoutedProvider | undefined]
      .filter((p): p is RoutedProvider => Boolean(p));
    const inSelectedChain = (answered: string) => selectedChain.some((p) => sameProvider(p, answered));
    const primaryProbe = primaryProbeLine(f, primary);

    // 1) Heartbeat wins for live-serving feeds: it records who really answered
    //    the last real user request, not a synthetic probe or a batch cache.
    if (hb) {
      const hbAge = (Date.now() - new Date(hb.observed_at).getTime()) / 60_000;
      const label = providerLabelFromProbe(hb.provider);
      const health = `${label} · ${agoLabel(hb.observed_at)}${hb.latency_ms != null ? ` · ${hb.latency_ms}ms` : ""}`;
      const fresh = hbAge <= (f.sessionOnly && !open ? 60 * 24 * 4 : (f.freshMins ?? 30));
      if (!hb.ok) {
        return { status: "DOWN", detail: hb.detail || `${label} returned nothing`, servedBy: label, health, primaryProbe };
      }
      if (!fresh) {
        return f.sessionOnly && !open
          ? { status: "IDLE", detail: `Market closed — last served by ${label} ${agoLabel(hb.observed_at)}.`, servedBy: label, health, primaryProbe: null }
          : { status: "DELAYED", detail: `Last served ${agoLabel(hb.observed_at)} — older than this feed's ${f.freshMins}m window.`, servedBy: label, health, primaryProbe };
      }
      if (!sameProvider(primary, hb.provider) && !inSelectedChain(hb.provider)) {
        return {
          status: "FALLBACK",
          detail: `${ROUTED_PROVIDER_LABEL[primary]} did not answer — served by ${label}${hb.detail ? ` (${hb.detail})` : ""}.`,
          servedBy: label, health, primaryProbe,
        };
      }
      return {
        status: "LIVE",
        detail: `${label} served ${hb.symbols ?? 0} symbol(s) ${agoLabel(hb.observed_at)} — real-time, no cache in the path.`,
        servedBy: label, health, primaryProbe: null,
      };
    }

    // 2) Otherwise the surface probe.
    if (probe) {
      const answered = probe.provider || "unknown";
      const providerLabel = providerLabelFromProbe(answered);
      const health = `probe ${probe.state} · ${agoLabel(probe.checked_at)}${probe.latency_ms != null ? ` · ${probe.latency_ms}ms` : ""}`;
      if (probe.state === "not_configured") {
        return { status: "NOT SET", detail: probe.detail || `${providerLabel} needs to be connected first`, servedBy: providerLabel, health, primaryProbe: null };
      }
      if (!probe.ok || probe.state === "failed") {
        if (f.sessionOnly && !open) {
          return { status: "IDLE", detail: `Market closed — ${probe.detail || "no live data outside session"}.`, servedBy: "—", health, primaryProbe: null };
        }
        if (ts && !stale && f.chain.length > 1) {
          return { status: "FALLBACK", detail: `${ROUTED_PROVIDER_LABEL[primary]} probe failed — fallback data is fresh. ${seen}`, servedBy: "fallback", health, primaryProbe };
        }
        return { status: "DOWN", detail: probe.detail || "probe failed", servedBy: "—", health, primaryProbe };
      }
      if (!sameProvider(primary, answered) && !inSelectedChain(answered)) {
        return { status: "FALLBACK", detail: `${ROUTED_PROVIDER_LABEL[primary]} did not answer — served by ${providerLabel}. ${seen}`, servedBy: providerLabel, health, primaryProbe };
      }
      if (probe.state === "degraded" || stale) {
        if (f.sessionOnly && !open) {
          return { status: "IDLE", detail: `Market closed — ${seen}.`, servedBy: providerLabel, health, primaryProbe: null };
        }
        return { status: "DELAYED", detail: `${probe.detail} · ${seen}`, servedBy: providerLabel, health, primaryProbe: null };
      }
      return { status: "LIVE", detail: `${providerLabel} answered · ${seen}`, servedBy: providerLabel, health, primaryProbe: null };
    }

    // 3) Batch/reference feeds: table freshness is the right signal.
    if (!f.table) return { status: "IDLE", detail: f.note ?? "No probe for this feed", servedBy: ROUTED_PROVIDER_LABEL[primary], health: "not probed", primaryProbe: null };
    if (!ts) return { status: "DOWN", detail: "never synced", servedBy: "—", health: "no data", primaryProbe: null };
    if (stale && f.sessionOnly && !open) {
      return { status: "IDLE", detail: `Market closed — ${seen}.`, servedBy: ROUTED_PROVIDER_LABEL[primary], health: `cache · ${agoLabel(ts)}`, primaryProbe: null };
    }
    return stale
      ? { status: "DELAYED", detail: seen, servedBy: ROUTED_PROVIDER_LABEL[primary], health: `cache · ${agoLabel(ts)}`, primaryProbe: null }
      : { status: "LIVE", detail: seen, servedBy: ROUTED_PROVIDER_LABEL[primary], health: `cache · ${agoLabel(ts)}`, primaryProbe: null };
  };

  const rows = useMemo(() => ROUTED_FEEDS.map((f) => ({ f, ...statusFor(f) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefs, surfaces, freshness, heartbeats]);

  // Auto-retry primary when any feed is on fallback OR delayed: re-probe the
  // affected providers with a backoff so the panel can promote back to LIVE
  // without a manual click. Runs only while the tab is visible.
  const retryRef = useRef<{ at: number; attempts: number }>({ at: 0, attempts: 0 });
  useEffect(() => {
    const retryProviders = new Set<string>();
    for (const r of rows) {
      if (r.status !== "FALLBACK" && r.status !== "DELAYED") continue;
      const primary = (prefFor(r.f.id)?.provider as RoutedProvider | undefined) ?? r.f.chain[0];
      if (primary === "kotak") retryProviders.add("kotak_neo");
      else if (primary === "alpha") retryProviders.add("alpha_vantage");
      else if (primary && primary !== "computed") retryProviders.add(primary);
    }
    if (retryProviders.size === 0) { retryRef.current = { at: 0, attempts: 0 }; return; }
    if (typeof document !== "undefined" && document.hidden) return;

    const tick = async () => {
      const attempts = retryRef.current.attempts;
      // Backoff: 30s → 2m → 10m, then hold at 10m.
      const wait = attempts === 0 ? 30_000 : attempts === 1 ? 120_000 : 600_000;
      if (Date.now() - retryRef.current.at < wait) return;
      retryRef.current = { at: Date.now(), attempts: attempts + 1 };
      try {
        await Promise.all([...retryProviders].map((p) =>
          supabase.functions.invoke("market-test-connection", { body: { provider: p, mode: "surfaces" } })
        ));
        qc.invalidateQueries({ queryKey: SELFTEST_QUERY_KEY as unknown as string[] });
      } catch { /* silent — this is a background recovery loop */ }
    };

    const iv = setInterval(tick, 15_000);
    // Fire once immediately on transition into fallback/delayed.
    tick();
    return () => clearInterval(iv);
  }, [rows, prefs, qc]);

  // Show the "auto-probing" pill only when a retry actually fired in the last
  // 90s — otherwise it lies about background activity between backoff windows.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(iv);
  }, []);
  const anyRetrying = rows.some((r) => r.status === "FALLBACK" || r.status === "DELAYED")
    && retryRef.current.at > 0 && (now - retryRef.current.at) < 90_000;

  const tally = rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {} as Record<Status, number>);
  const overridden = prefs.length;

  const groups: FeedGroup[] = ["live", "history", "account", "reference"];

  return (
    <HudPanel
      title="Feed Routing"
      index="RTE"
      live={(tally.DOWN ?? 0) > 0 ? "err" : (tally.FALLBACK ?? 0) + (tally.DELAYED ?? 0) > 0 ? "warn" : "ok"}
      bodyClass="overflow-visible"
      // The same self-test the Providers panel runs, surfaced here too — this
      // is the table people are staring at when they want to re-check.
      actions={
        <Btn size="sm" disabled={selfTest.isPending} onClick={async () => {
          try {
            const r = await selfTest.mutateAsync();
            const p = (r as any)?.providers ?? {};
            const okN = Object.values(p).filter((x: any) => x?.ok).length;
            push(`Self-test complete — ${okN}/${Object.keys(p).length} providers ok`, "ok");
          } catch (e) {
            push(toSafeError(e, "Self-test failed").message, "err");
          }
        }}>
          {selfTest.isPending ? "testing…" : "test everything"}
        </Btn>
      }
    >

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {(["LIVE", "DELAYED", "FALLBACK", "DOWN", "IDLE", "NOT SET"] as Status[]).map((s) => (
            <Chip key={s} tone={STATUS_TONE[s] as never}>{tally[s] ?? 0} {s.toLowerCase()}</Chip>
          ))}
          {overridden > 0 && (
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
              {overridden} routed manually (per-user override)
            </span>
          )}
          {anyRetrying && (
            <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: "auto" }}>
              auto-probing primary in background…
            </span>
          )}
        </div>


        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={head}>Feed</th>
                <th style={head}>Status</th>
                <th style={head}>Served by / health</th>
                <th style={head}>Primary</th>
                <th style={head}>Fallback</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const groupRows = rows.filter((r) => r.f.group === g);
                if (groupRows.length === 0) return null;
                return (
                  <Fragment key={g}>
                    <tr>
                      <td colSpan={5} style={{ ...head, background: "var(--panel, transparent)", color: "var(--accent)" }}>
                        {FEED_GROUP_LABEL[g]}
                      </td>
                    </tr>
                    {groupRows.map(({ f, status, detail, servedBy, health, primaryProbe }) => {
                      const pref = prefFor(f.id);
                      const primary = (pref?.provider ?? "auto") as RoutedProvider | "auto";
                      const fallback = (pref?.fallback_provider ?? "auto") as RoutedProvider | "auto";
                      const fallbackValue = fallback !== "auto" && fallback === primary ? "auto" : fallback;
                      const chain = [
                        ...(primary !== "auto" ? [primary] : []),
                        ...(fallbackValue !== "auto" ? [fallbackValue] : []),
                        ...f.chain,
                      ].filter((p, i, a) => a.indexOf(p) === i);
                      const chainLabel = chain.map((p) => ROUTED_PROVIDER_LABEL[p]).join(" → ");
                      const unsupported = f.unsupported ?? {};
                      const servingCanon = canonicalProviderId(servedBy);
                      const stats = providerStats[servingCanon];
                      const unsupTitle = Object.entries(unsupported)
                        .map(([p, why]) => `${ROUTED_PROVIDER_LABEL[p as RoutedProvider]}: ${why}`)
                        .join("\n");
                      return (
                        <tr key={f.id} title={`${detail}\nchain: ${chainLabel}${unsupTitle ? `\n\n${unsupTitle}` : ""}`}>
                          <td style={cell}>
                            <div style={{ color: "var(--text)", fontFamily: "var(--font-hud)" }}>
                              {f.label}
                              {unsupTitle && (
                                <span title={unsupTitle} style={{ marginLeft: 6, fontSize: 9, color: "var(--text-muted)", cursor: "help" }}>ⓘ</span>
                              )}
                            </div>
                            <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{chainLabel}</div>
                          </td>
                          <td style={cell}>
                            <Chip tone={STATUS_TONE[status] as never}>{status}</Chip>
                            <div style={{ fontSize: 10, color: "var(--text-muted)", maxWidth: 260 }}>{detail}</div>
                            {primaryProbe && (
                              <div style={{ fontSize: 10, color: "var(--text-muted)", maxWidth: 260, opacity: 0.85 }}>
                                {primaryProbe}
                              </div>
                            )}
                          </td>
                          <td style={cell}>
                            <div style={{ fontSize: 10, color: "var(--text)" }}>{servedBy}</div>
                            <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{health}</div>
                            {stats && stats.attempts > 0 && (
                              <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                                {stats.okRate}% ok · {stats.p50 != null ? `${stats.p50}ms p50` : "—"} · {stats.attempts} probes / 24h
                              </div>
                            )}
                          </td>
                          <td style={cell}>
                            {f.routable === false ? (
                              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>fixed</span>
                            ) : (
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <select
                                  value={primary}
                                  disabled={save.isPending}
                                  onChange={(e) => save.mutate({ feedId: f.id, primary: e.target.value, fallback })}
                                  className="focus-outline" style={sel}
                                >
                                  <option value="auto">Auto (default chain)</option>
                                  {f.chain.filter((p) => !unsupported[p]).map((p) => (
                                    <option key={p} value={p}>{ROUTED_PROVIDER_LABEL[p]}</option>
                                  ))}
                                </select>
                                {(primary !== "auto" || fallback !== "auto") && (
                                  <button
                                    className="focus-outline"
                                    title="Your manual override for this feed — click to reset to the default chain"
                                    disabled={save.isPending}
                                    onClick={() => save.mutate({ feedId: f.id, primary: "auto", fallback: "auto" })}
                                    style={{
                                      fontSize: 9, fontFamily: "var(--font-hud)", letterSpacing: "0.1em",
                                      textTransform: "uppercase", color: "var(--accent)",
                                      border: "1px solid var(--edge-strong)", background: "transparent",
                                      padding: "2px 5px", cursor: "pointer", whiteSpace: "nowrap",
                                    }}
                                  >
                                    yours · reset
                                  </button>
                                )}
                              </div>
                            )}
                          </td>

                          <td style={cell}>
                            {f.routable === false || f.chain.length < 2 ? (
                              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>—</span>
                            ) : (
                              <select
                                value={fallbackValue}
                                disabled={save.isPending}
                                onChange={(e) => save.mutate({ feedId: f.id, primary, fallback: e.target.value })}
                                className="focus-outline" style={sel}
                              >
                                <option value="auto">Auto (rest of chain)</option>
                                {f.chain.filter((p) => !unsupported[p] && p !== primary).map((p) => (
                                  <option key={p} value={p}>{ROUTED_PROVIDER_LABEL[p]}</option>
                                ))}
                              </select>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </HudPanel>
  );
}
