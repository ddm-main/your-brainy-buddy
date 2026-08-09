// Feed Routing — every feed the app consumes, grouped, with a live status
// pill, the provider chain in effect, and separate Primary / Fallback
// selectors. Preferences live in market_feed_prefs (per user, RLS-scoped);
// the edge resolver builds the chain as primary → fallback → built-in chain.
//
// Status derivation itself lives in `@/lib/market/feedStatus` so this panel and
// the navbar chip can never report different numbers again.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { useRunSelfTest, useProviderStats24h, canonicalProviderId, SELFTEST_QUERY_KEY } from "@/lib/market/selftest";
import { useFeedStatus, STATUS_TONE, type Status } from "@/lib/market/feedStatus";
import { currentUserId } from "@/lib/useSession";
import {
  ROUTED_PROVIDER_LABEL, FEED_GROUP_LABEL,
  type RoutedProvider, type FeedGroup,
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

export default function FeedRoutingPanel() {
  const qc = useQueryClient();
  const push = useUi((s) => s.push);
  const selfTest = useRunSelfTest();

  // Account-plane surfaces (funds / holdings / positions / orders) are a
  // per-user broker concern and live on Market → Config → Account feed health.
  // This admin panel is platform data feeds only, so a personal session
  // problem can never read as a platform outage.
  const { rows: allRows, tally, prefs, sessionOpen, holiday } = useFeedStatus();
  const rows = useMemo(() => allRows.filter((r) => r.f.group !== "account"), [allRows]);
  const { data: providerStats = {} } = useProviderStats24h();

  const prefFor = (feedId: string) => prefs.find((p) => p.feed_id === feedId);

  // Routing is app-wide (scope='system', user_id null) — that is the only
  // scope the edge resolver reads. Writing per-user rows here silently did
  // nothing to the actual data pipeline.
  const save = useMutation({
    mutationFn: async ({ feedId, primary, fallback }: { feedId: string; primary: string; fallback: string }) => {
      const uid = await currentUserId();
      if (!uid) throw new Error("Not signed in");
      // Replace rather than upsert: the only unique index is partial
      // (feed_id WHERE scope='system'), which PostgREST cannot infer.
      const { error: delErr } = await supabase.from("market_feed_prefs")
        .delete().eq("feed_id", feedId).eq("scope", "system");
      if (delErr) throw delErr;
      if (primary === "auto" && fallback === "auto") return;
      const { error } = await supabase.from("market_feed_prefs").insert(
        {
          scope: "system", user_id: null, feed_id: feedId,
          provider: primary,
          fallback_provider: fallback === "auto" ? null : fallback,
        } as never,
      );
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["market", "feed-prefs"] });
      push("Feed routing updated", "ok");
    },
    onError: (e) => push(toSafeError(e, "Could not save feed routing").message, "err"),
  });

  // Auto-retry the primary of any feed on fallback/delayed, with a backoff.
  // Keyed on the *set of providers to retry* rather than on `rows`: the old
  // effect re-ran (and fired an immediate probe) on every status refresh,
  // which turned the backoff into a burst of background probes.
  const retryKey = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      // Only genuine recovery cases. A DELAYED on-demand or cache-backed feed
      // is working as designed, and probing it every 30 s burned quota while
      // never changing the verdict.
      const recoverable = r.status === "DOWN" || (r.status === "FALLBACK" && !r.f.onDemand);
      if (!recoverable) continue;
      if (r.f.sessionOnly && !sessionOpen) continue;
      const primary = (prefFor(r.f.id)?.provider as RoutedProvider | undefined) ?? r.f.chain[0];
      if (primary === "kotak") set.add("kotak_neo");
      else if (primary === "alpha") set.add("alpha_vantage");
      else if (primary && primary !== "computed") set.add(primary);
    }
    return [...set].sort().join(",");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, prefs]);

  const attemptsRef = useRef(0);
  const [lastRetryAt, setLastRetryAt] = useState(0);

  useEffect(() => {
    if (!retryKey) { attemptsRef.current = 0; return; }
    const providers = retryKey.split(",");
    let cancelled = false;
    let at = 0;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) return;
      // Backoff: 30s → 2m → 10m, then hold at 10m.
      const attempts = attemptsRef.current;
      const wait = attempts === 0 ? 30_000 : attempts === 1 ? 120_000 : 600_000;
      if (at && Date.now() - at < wait) return;
      at = Date.now();
      attemptsRef.current = attempts + 1;
      setLastRetryAt(at);
      try {
        await Promise.all(providers.map((p) =>
          supabase.functions.invoke("market-test-connection", { body: { provider: p, mode: "surfaces" } })
        ));
        if (!cancelled) qc.invalidateQueries({ queryKey: SELFTEST_QUERY_KEY as unknown as string[] });
      } catch { /* silent — background recovery loop */ }
    };

    const iv = setInterval(tick, 15_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [retryKey, qc]);

  // "auto-probing" pill only while a retry actually fired recently.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(iv);
  }, []);
  const anyRetrying = !!retryKey && lastRetryAt > 0 && now - lastRetryAt < 90_000;

  const counts: Record<Status, number> = {
    LIVE: tally.live, DELAYED: tally.delayed, FALLBACK: tally.fallback,
    DOWN: tally.down, IDLE: tally.idle, "NOT SET": tally.notSet,
    "NOT CHECKED": tally.notChecked,
  };
  const overridden = prefs.length;

  const groups: FeedGroup[] = ["live", "history", "reference"];

  return (
    <HudPanel
      title="Feed Routing"
      index="RTE"
      live={counts.DOWN > 0 ? "err" : counts.FALLBACK + counts.DELAYED > 0 ? "warn" : "ok"}
      bodyClass="overflow-visible"
      // The same self-test the Providers panel runs, surfaced here too — this
      // is the table people are staring at when they want to re-check.
      actions={
        <Btn size="sm" disabled={selfTest.isPending} onClick={async () => {
          try {
            const r = await selfTest.mutateAsync();
            const raw = (r as any)?.providers;
            const list: any[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
            const okN = list.filter((x: any) => x?.ok).length;
            push(list.length
              ? `Self-test complete — ${okN}/${list.length} providers ok`
              : "Self-test complete", "ok");
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
          <span style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase" }}>Platform · {tally.ok}/{tally.total} healthy</span>
          {(["LIVE", "DELAYED", "FALLBACK", "DOWN", "IDLE", "NOT SET"] as Status[])
            .filter((s) => counts[s] > 0)
            .map((s) => (
              <Chip key={s} tone={STATUS_TONE[s] as never}>{counts[s]} {s.toLowerCase()}</Chip>
            ))}
          <Chip tone={holiday ? "neutral" : sessionOpen ? "ok" : "neutral"}>
            {holiday ? "NSE holiday" : sessionOpen ? "session open" : "session closed"}
          </Chip>
          {overridden > 0 && <Chip tone="accent">{overridden} routed manually</Chip>}
          {anyRetrying && (
            <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: "auto" }}>auto-probing…</span>
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
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                          <span>{FEED_GROUP_LABEL[g]}</span>
                        </div>
                      </td>
                    </tr>

                    {groupRows.map(({ f, status, detail, servedBy, health, primaryProbe, chainHealth, autoSwitched }) => {
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
                            {/* Per-provider health of the chain: a dead fallback
                                stays visible even while the feed itself is green. */}
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 3 }}>
                              {chainHealth.map((c) => (
                                <span
                                  key={c.provider}
                                  title={`${c.label}: ${c.state}${c.detail ? ` — ${c.detail}` : ""}${c.checkedAt ? ` (${new Date(c.checkedAt).toLocaleString()})` : ""}`}
                                  style={{
                                    fontSize: 9, padding: "0 4px", borderRadius: 3, cursor: "help",
                                    border: "1px solid var(--border)",
                                    color:
                                      c.state === "ok" ? "var(--ok, #3fbf7f)"
                                      : c.state === "failed" ? "var(--danger, #ff5f5f)"
                                      : c.state === "degraded" ? "var(--warn, #e0a13a)"
                                      : "var(--text-muted)",
                                  }}
                                >
                                  {c.label}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td style={cell}>
                            <Chip tone={STATUS_TONE[status] as never}>{status}</Chip>
                            {autoSwitched && status !== "DOWN" && (
                              <Chip tone="warn">auto-switched</Chip>
                            )}
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
                                    title="App-wide override for this feed — click to reset to the default chain"
                                    disabled={save.isPending}
                                    onClick={() => save.mutate({ feedId: f.id, primary: "auto", fallback: "auto" })}
                                    style={{
                                      fontSize: 9, fontFamily: "var(--font-hud)", letterSpacing: "0.1em",
                                      textTransform: "uppercase", color: "var(--accent)",
                                      border: "1px solid var(--edge-strong)", background: "transparent",
                                      padding: "2px 5px", cursor: "pointer", whiteSpace: "nowrap",
                                    }}
                                  >
                                    reset
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
