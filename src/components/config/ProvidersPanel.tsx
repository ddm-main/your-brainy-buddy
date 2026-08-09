// Providers panel for Market Config — clickable list of every data provider.
// Selecting a row opens ProviderDetail, which shows what that provider feeds,
// whether each feed is live, who actually served it and where the app uses it.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import HudPanel from "@/components/hud/HudPanel";
import { HudModal } from "@/components/hud/HudModal";
import { Btn, Chip, inputStyle } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { ChevronRight, KeyRound, TestTube2, Settings2 } from "lucide-react";
import ProviderDetail from "./providers/ProviderDetail";
import FeedRoutingPanel from "./providers/FeedRoutingPanel";
import { PROVIDERS, PROVIDER_ORDER, type ProviderId } from "./providers/feedCatalog";
import { ago, callCreds, callTest, clean, type CredRow, type HealthRow } from "./providers/providerUtils";
import { useRunSelfTest, SELFTEST_QUERY_KEY } from "@/lib/market/selftest";
import { useDesignateSystemFeed, useSystemFeed } from "@/lib/market/hooks";

export type { ProviderId };

export default function ProvidersPanel() {
  const nav = useNavigate();
  const push = useUi((s) => s.push);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProviderId | null>(null);
  const [editing, setEditing] = useState<ProviderId | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const selfTest = useRunSelfTest();

  // The app-wide market-data feed. Market data is operator-owned: it comes from
  // a broker connection designated here, never from a user's personal session.
  // (This replaces the old standalone "Data Feed Connection" panel — the
  // provider rows below already list the same brokers.)
  const { data: feed } = useSystemFeed();
  const designate = useDesignateSystemFeed();
  const { data: dataRows = [] } = useQuery({
    queryKey: ["market", "data-feed-rows"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("market_api_settings")
        .select("id,active_provider,connection_status,ucc,greeting_name")
        .eq("purpose", "data");
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string; active_provider: string; connection_status: string | null;
        ucc: string | null; greeting_name: string | null;
      }>;
    },
    refetchInterval: 120_000,
  });
  const feedRowFor = (p: ProviderId) => dataRows.find((r) => r.active_provider === p) ?? null;


  const { data: creds } = useQuery({
    queryKey: ["market", "provider-credentials"],
    queryFn: async () => {
      const j = await callCreds({ mode: "status" });
      return (j?.providers ?? []) as CredRow[];
    },
    staleTime: 60_000,
  });

  // Last recorded outcomes per provider, so status survives a reload.
  const { data: health } = useQuery({
    queryKey: ["market", "provider-health-latest"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("market_provider_health")
        .select("provider,ok,error,created_at")
        .order("created_at", { ascending: false })
        // EGRESS: 300 rows of probe errors every 2 min was ~40 KB/poll; the
        // panel only renders the latest handful per provider.
        .limit(80);
      if (error) throw error;
      return data as HealthRow[];
    },
    refetchInterval: 300_000,
    staleTime: 120_000,
  });

  const historyFor = useMemo(() => {
    const m = new Map<string, HealthRow[]>();
    for (const r of health ?? []) {
      const list = m.get(r.provider) ?? [];
      list.push(r);
      m.set(r.provider, list);
    }
    return m;
  }, [health]);

  const credFor = (p: ProviderId) => (creds ?? []).find((c) => c.provider === p) ?? null;

  const test = async (p: ProviderId) => {
    if (busy) return;
    setBusy(`test-${p}`);
    try {
      const j = await callTest({ provider: p });
      const ok = !!j?.ok;
      const detail = clean((j?.detail as string) ?? (j?.error as string));
      push(ok ? `${PROVIDERS[p].name} OK` : `${PROVIDERS[p].name} failed${detail ? `: ${detail}` : ""}`, ok ? "ok" : "err");
      // The test writes fresh surface rows too — refresh both, or the feed
      // table keeps showing the pre-test state until the next cron tick.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["market", "provider-health-latest"] }),
        qc.invalidateQueries({ queryKey: SELFTEST_QUERY_KEY as unknown as string[] }),
      ]);
    } catch (e) {
      const msg = clean(toSafeError(e, "Test failed").message);
      push(msg ?? "Test failed", "err");
    } finally { if (mounted.current) setBusy(null); }
  };

  const saveKey = async () => {
    if (!editing || busy) return;
    const provider = editing;
    setBusy("save");
    try {
      await callCreds({ mode: "save", provider, api_key: keyInput.trim() });
      setKeyInput("");
      setEditing(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["market", "provider-credentials"] }),
        qc.invalidateQueries({ queryKey: ["market", "provider-health-latest"] }),
      ]);
      const j = await callTest({ provider });
      const ok = !!j?.ok;
      const detail = clean((j?.detail as string) ?? (j?.error as string));
      push(ok ? `${PROVIDERS[provider].name} key saved and verified` : `${PROVIDERS[provider].name} key saved, test failed${detail ? `: ${detail}` : ""}`, ok ? "ok" : "err");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["market", "provider-credentials"] }),
        qc.invalidateQueries({ queryKey: ["market", "provider-health-latest"] }),
      ]);
    } catch (e) {
      push(toSafeError(e, "Could not save key").message, "err");
    } finally { if (mounted.current) setBusy(null); }
  };

  const clearKey = async (p: ProviderId) => {
    if (busy) return;
    setBusy("clear");
    try {
      await callCreds({ mode: "clear", provider: p });
      push(`${PROVIDERS[p].name} key removed`, "ok");
      await qc.invalidateQueries({ queryKey: ["market", "provider-credentials"] });
    } catch (e) {
      push(toSafeError(e, "Could not remove key").message, "err");
    } finally { if (mounted.current) setBusy(null); }
  };

  const openEdit = (p: ProviderId) => {
    // Broker sessions (Kotak, Shoonya) are established in Market Settings —
    // they need far more than a single API-key field.
    if (PROVIDERS[p].edit === "kotak" || PROVIDERS[p].edit === "broker") { nav("/market/settings"); return; }
    setKeyInput("");
    setEditing(p);
  };

  const rows = PROVIDER_ORDER.map((p) => {
    const meta = PROVIDERS[p];
    const cred = credFor(p);
    const rawHp = historyFor.get(p)?.[0] ?? null;
    const hp = cred?.updated_at && rawHp?.created_at && new Date(rawHp.created_at).getTime() < new Date(cred.updated_at).getTime() ? null : rawHp;
    // A saved key OR the edge-secret fallback counts as configured; the panel
    // can't see edge secrets, so only flag it as "check key" after a failure.
    const keyMissing = meta.edit === "key" && !cred?.key_set && hp?.ok === false;

    let tone: "ok" | "warn" | "err" | "neutral" = "neutral";
    let label = "idle";
    let detail: string | null = null;
    let at: string | null = null;

    if (cred?.last_tested_at && cred.last_test_ok != null) {
      tone = cred.last_test_ok ? "ok" : "err";
      label = cred.last_test_ok ? "reachable" : "failed";
      detail = clean(cred.last_test_detail);
      at = cred.last_tested_at;
    } else if (hp) {
      tone = hp.ok ? "ok" : "warn";
      label = hp.ok ? "reachable" : keyMissing ? "check key" : "degraded";
      detail = clean(hp.error); at = hp.created_at;
    } else if (meta.edit === "key" && cred?.key_set) {
      tone = "neutral"; label = "saved — test";
      detail = clean(cred.last_test_detail); at = cred.updated_at;
    } else if (meta.edit === "key" && !cred?.key_set) {
      tone = "neutral"; label = "edge secret";
    } else {
      tone = "neutral"; label = "untested";
    }
    if ((p === "kotak_neo" || p === "shoonya") && hp && !hp.ok) label = "degraded → yahoo";

    return { p, meta, cred, tone, label, detail, at };
  });

  const anyBad = rows.some((r) => r.tone === "err");
  const anyWarn = rows.some((r) => r.tone === "warn");
  const editMeta = editing ? PROVIDERS[editing] : null;
  const editCred = editing ? credFor(editing) : null;

  return (
    <>
      {selected ? (
        <ProviderDetail
          id={selected}
          cred={credFor(selected)}
          health={historyFor.get(selected) ?? []}
          busy={busy}
          onBack={() => setSelected(null)}
          onEdit={openEdit}
          onTest={test}
          liveDetail={null}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <FeedRoutingPanel />
        <HudPanel
          title="Providers"
          index="PRV"
          live={anyBad ? "err" : anyWarn ? "warn" : "ok"}
          bodyClass="overflow-visible"
          actions={
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Chip tone={feed?.healthy ? "ok" : feed?.configured ? "warn" : "neutral"}>
                {feed?.healthy
                  ? `data feed live · ${feed.provider ?? "broker"}`
                  : feed?.configured
                  ? `data feed degraded · ${feed.status}`
                  : "no data feed · public vendors"}
              </Chip>
              {feed?.last_sync_at && (
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>synced {ago(feed.last_sync_at)}</span>
              )}
              {feed?.last_error && (
                <span style={{ fontSize: 10, color: "var(--danger, #ef4444)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={feed.last_error}>
                  {feed.last_error}
                </span>
              )}
              {selfTest.isPending && (
                <span style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "var(--font-hud)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
                  testing…
                </span>
              )}
            </div>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {rows.map(({ p, meta, tone, label, detail, at }) => (
              <div
                key={p}
                role="button"
                tabIndex={0}
                onClick={() => setSelected(p)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(p); } }}
                style={{ border: "1px solid var(--edge)", padding: "4px 8px", background: "rgba(255,255,255,0.015)", cursor: "pointer" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }} title={meta.feeds.map((f) => f.label).join(" · ")}>
                  <ChevronRight size={12} style={{ color: "var(--text-muted)" }} />
                  <span style={{ fontFamily: "var(--font-hud)", fontSize: 12, color: "var(--text)", letterSpacing: "0.04em" }}>{meta.name}</span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.14em" }}>{meta.role}</span>
                  {meta.primary && <Chip tone="accent">primary</Chip>}
                  <Chip tone={tone}>{label}</Chip>
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{meta.feeds.length} feeds</span>
                  {at && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{ago(at)}</span>}
                  <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
                    {(() => {
                      // Broker data-feed designation lives on the provider row
                      // itself now — no separate connections panel.
                      const row = feedRowFor(p);
                      if (!row) return null;
                      if (feed?.id === row.id && feed?.designated) return <Chip tone="accent">active feed</Chip>;
                      return (
                        <Btn size="sm" disabled={designate.isPending}
                          title={`Serve app-wide market data from ${meta.name}`}
                          onClick={async () => {
                            try { await designate.mutateAsync(row.id); push("Data feed updated", "ok"); }
                            catch (e) { push(toSafeError(e, "Could not designate feed").message, "err"); }
                          }}>use as feed</Btn>
                      );
                    })()}
                    <Btn size="sm" onClick={() => openEdit(p)} disabled={busy !== null} title={`Edit ${meta.name}`}>
                      {meta.edit === "kotak" ? <KeyRound size={11} style={{ marginRight: 4 }} /> : <Settings2 size={11} style={{ marginRight: 4 }} />}
                      Edit
                    </Btn>
                    <Btn size="sm" onClick={() => test(p)} disabled={busy !== null}>
                      <TestTube2 size={11} style={{ marginRight: 4 }} />{busy === `test-${p}` ? "testing…" : "Test"}
                    </Btn>
                  </span>
                </div>
                {detail && tone !== "ok" && (
                  <div style={{ marginTop: 2, fontSize: 10, color: tone === "err" ? "var(--danger)" : "var(--text-muted)" }}>{detail}</div>
                )}
              </div>
            ))}
          </div>
        </HudPanel>
        </div>
      )}

      <HudModal open={editing !== null} onClose={() => setEditing(null)} title={editMeta ? `${editMeta.name} — settings` : ""} width={460}>
        {editMeta && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 12, color: "var(--text-dim)" }}>
            <div>
              <div className="hud-label" style={{ color: "var(--text-muted)", marginBottom: 4 }}>Feeds</div>
              <div>{editMeta.feeds.map((f) => f.label).join(" · ")}</div>
            </div>

            {editMeta.edit === "key" ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="hud-label" style={{ color: "var(--text-muted)" }}>API key</span>
                  <Chip tone={editCred?.key_set ? "ok" : "warn"}>{editCred?.key_set ? `set ${editCred.key_hint ?? ""}` : "not set"}</Chip>
                  {editCred?.key_set && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>updated {ago(editCred.updated_at)}</span>}
                </div>
                <input
                  type="password"
                  autoComplete="off"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder="Paste API key"
                  style={{ ...inputStyle, width: "100%" }}
                />
                <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                  Stored encrypted server-side; never returned to the browser. Falls back to the
                  {" "}<code>{editMeta.envName}</code> edge secret when no key is saved here.
                  {editMeta.docs && <> · <a href={editMeta.docs} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>get a key</a></>}
                </div>
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  {editCred?.key_set && (
                    <Btn size="sm" onClick={() => editing && clearKey(editing)} disabled={busy !== null}>Remove</Btn>
                  )}
                  <Btn size="sm" onClick={() => editing && test(editing)} disabled={busy !== null}>Test</Btn>
                  <Btn size="sm" onClick={saveKey} disabled={busy !== null || keyInput.trim().length < 8}>
                    {busy === "save" ? "saving…" : "Save key"}
                  </Btn>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  Public endpoint — no credentials required. Status comes from the last live probe.
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <Btn size="sm" onClick={() => editing && test(editing)} disabled={busy !== null}>Test now</Btn>
                </div>
              </>
            )}
          </div>
        )}
      </HudModal>
    </>
  );
}
