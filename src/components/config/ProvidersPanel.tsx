// Providers panel for Market Config — one compact row per data provider with
// live status, an Edit action (key entry / deep link / detail sheet) and Test.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import HudPanel from "@/components/hud/HudPanel";
import { HudModal } from "@/components/hud/HudModal";
import { Btn, Chip, inputStyle } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { SAFE_SUPABASE_URL } from "@/lib/supabaseSafe";
import { authFetch } from "@/lib/authFetch";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { KeyRound, TestTube2, Settings2 } from "lucide-react";

export type ProviderId = "kotak_neo" | "yahoo" | "fmp" | "alpha_vantage" | "nse" | "bse";
type EditKind = "kotak" | "key" | "info";

const META: Record<ProviderId, {
  name: string; role: string; feeds: string[]; primary?: boolean;
  edit: EditKind; docs?: string; envName?: string;
}> = {
  kotak_neo:     { name: "Kotak Neo", role: "Primary quotes / EOD", feeds: ["Live LTP", "Depth", "Session-backed EOD"], primary: true, edit: "kotak" },
  yahoo:         { name: "Yahoo Finance", role: "Fallback market data", feeds: ["Quotes", "OHLC", "Fundamentals", "Indices"], edit: "info" },
  fmp:           { name: "Financial Modeling Prep", role: "Fundamentals", feeds: ["Market cap", "PE / PB / ROE", "Balance sheet", "Cash flow"], edit: "key", docs: "https://site.financialmodelingprep.com/developer/docs", envName: "FINANCIAL_MODELING_PREP_API_KEY" },
  alpha_vantage: { name: "Alpha Vantage", role: "Technicals", feeds: ["SMA / EMA", "RSI", "MACD", "ADX / ATR"], edit: "key", docs: "https://www.alphavantage.co/support/#api-key", envName: "ALPHA_VANTAGE_API_KEY" },
  nse:           { name: "NSE", role: "Exchange data", feeds: ["Market status", "Index constituents", "Bulk deals", "Corp actions"], edit: "info" },
  bse:           { name: "BSE", role: "Exchange data", feeds: ["Corp actions", "Announcements", "Circulars"], edit: "info" },
};

const ORDER: ProviderId[] = ["kotak_neo", "yahoo", "fmp", "alpha_vantage", "nse", "bse"];

type CredRow = {
  provider: string; key_set: boolean; key_hint: string | null;
  last_tested_at: string | null; last_test_ok: boolean | null; last_test_detail: string | null;
};

type HealthRow = { provider: string; ok: boolean; error: string | null; created_at: string };

function ago(ts: string | null | undefined): string {
  if (!ts) return "";
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Broker error pages come back as raw HTML — keep the readable part only. */
function clean(detail: string | null | undefined): string | null {
  if (!detail) return null;
  const text = detail.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text || null;
}

async function callCreds(body: Record<string, unknown>) {
  const r = await authFetch(`${SAFE_SUPABASE_URL}/functions/v1/market-provider-credentials`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(j?.error ?? r.statusText);
  return j;
}

export default function ProvidersPanel() {
  const nav = useNavigate();
  const push = useUi((s) => s.push);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [live, setLive] = useState<Partial<Record<ProviderId, { ok: boolean; detail: string | null; at: string }>>>({});
  const [editing, setEditing] = useState<ProviderId | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const { data: creds } = useQuery({
    queryKey: ["market", "provider-credentials"],
    queryFn: async () => {
      const j = await callCreds({ mode: "status" });
      return (j?.providers ?? []) as CredRow[];
    },
    staleTime: 60_000,
  });

  // Last recorded outcome per provider, so status survives a reload.
  const { data: health } = useQuery({
    queryKey: ["market", "provider-health-latest"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("market_provider_health")
        .select("provider,ok,error,created_at")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data as HealthRow[];
    },
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const lastHealth = useMemo(() => {
    const m = new Map<string, HealthRow>();
    for (const r of health ?? []) if (!m.has(r.provider)) m.set(r.provider, r);
    return m;
  }, [health]);

  const credFor = (p: ProviderId) => (creds ?? []).find((c) => c.provider === p) ?? null;

  const test = async (p: ProviderId) => {
    if (busy) return;
    setBusy(`test-${p}`);
    try {
      const r = await authFetch(`${SAFE_SUPABASE_URL}/functions/v1/market-test-connection`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: p }),
      });
      const j = await r.json().catch(() => ({}));
      const ok = !!j?.ok;
      const detail = clean(j?.detail ?? j?.error);
      if (mounted.current) setLive((s) => ({ ...s, [p]: { ok, detail, at: new Date().toISOString() } }));
      push(ok ? `${META[p].name} OK` : `${META[p].name} failed${detail ? `: ${detail}` : ""}`, ok ? "ok" : "err");
      await qc.invalidateQueries({ queryKey: ["market", "provider-health-latest"] });
    } catch (e) {
      const msg = clean(toSafeError(e, "Test failed").message);
      if (mounted.current) setLive((s) => ({ ...s, [p]: { ok: false, detail: msg, at: new Date().toISOString() } }));
      push(msg ?? "Test failed", "err");
    } finally { if (mounted.current) setBusy(null); }
  };

  const saveKey = async () => {
    if (!editing || busy) return;
    setBusy("save");
    try {
      await callCreds({ mode: "save", provider: editing, api_key: keyInput.trim() });
      push(`${META[editing].name} key saved`, "ok");
      setKeyInput("");
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ["market", "provider-credentials"] });
    } catch (e) {
      push(toSafeError(e, "Could not save key").message, "err");
    } finally { if (mounted.current) setBusy(null); }
  };

  const clearKey = async (p: ProviderId) => {
    if (busy) return;
    setBusy("clear");
    try {
      await callCreds({ mode: "clear", provider: p });
      push(`${META[p].name} key removed`, "ok");
      await qc.invalidateQueries({ queryKey: ["market", "provider-credentials"] });
    } catch (e) {
      push(toSafeError(e, "Could not remove key").message, "err");
    } finally { if (mounted.current) setBusy(null); }
  };

  const openEdit = (p: ProviderId) => {
    if (META[p].edit === "kotak") { nav("/market/settings"); return; }
    setKeyInput("");
    setEditing(p);
  };

  const rows = ORDER.map((p) => {
    const meta = META[p];
    const cred = credFor(p);
    const hp = lastHealth.get(p);
    const lv = live[p];
    const keyMissing = meta.edit === "key" && !cred?.key_set;

    let tone: "ok" | "warn" | "err" | "neutral" = "neutral";
    let label = "idle";
    let detail: string | null = null;
    let at: string | null = null;

    if (lv) {
      tone = lv.ok ? "ok" : "err"; label = lv.ok ? "reachable" : "failed";
      detail = lv.detail; at = lv.at;
    } else if (keyMissing) {
      tone = "warn"; label = "key missing";
    } else if (hp) {
      tone = hp.ok ? "ok" : "warn";
      label = hp.ok ? "reachable" : "degraded";
      detail = clean(hp.error); at = hp.created_at;
    } else {
      tone = "neutral"; label = "untested";
    }
    if (!lv && p === "kotak_neo" && hp && !hp.ok) label = "degraded → yahoo";

    return { p, meta, cred, tone, label, detail, at, keyMissing };
  });

  const anyBad = rows.some((r) => r.tone === "err");
  const anyWarn = rows.some((r) => r.tone === "warn");
  const editMeta = editing ? META[editing] : null;
  const editCred = editing ? credFor(editing) : null;

  return (
    <>
      <HudPanel title="Providers" index="PRV" live={anyBad ? "err" : anyWarn ? "warn" : "ok"} bodyClass="overflow-visible">
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {rows.map(({ p, meta, tone, label, detail, at }) => (
            <div key={p} style={{ border: "1px solid var(--edge)", padding: "4px 8px", background: "rgba(255,255,255,0.015)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }} title={meta.feeds.join(" · ")}>
                <span style={{ fontFamily: "var(--font-hud)", fontSize: 12, color: "var(--text)", letterSpacing: "0.04em" }}>{meta.name}</span>
                <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.14em" }}>{meta.role}</span>
                {meta.primary && <Chip tone="accent">primary</Chip>}
                <Chip tone={tone}>{label}</Chip>
                {at && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{ago(at)}</span>}
                <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
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

      <HudModal open={editing !== null} onClose={() => setEditing(null)} title={editMeta ? `${editMeta.name} — settings` : ""} width={460}>
        {editMeta && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 12, color: "var(--text-dim)" }}>
            <div>
              <div className="hud-label" style={{ color: "var(--text-muted)", marginBottom: 4 }}>Feeds</div>
              <div>{editMeta.feeds.join(" · ")}</div>
            </div>

            {editMeta.edit === "key" ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="hud-label" style={{ color: "var(--text-muted)" }}>API key</span>
                  <Chip tone={editCred?.key_set ? "ok" : "warn"}>{editCred?.key_set ? `set ${editCred.key_hint ?? ""}` : "not set"}</Chip>
                  {editCred?.key_set && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>updated {ago(editCred.last_tested_at)}</span>}
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
