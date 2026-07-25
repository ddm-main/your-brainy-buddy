// System Data — admin-only config for the app-wide market data pipeline
// and data providers (Kotak Neo primary, Yahoo/NSE/BSE/Alpha Vantage/FMP fallbacks).
// This is NOT a per-user broker connection — that lives at /market/settings.
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { SAFE_SUPABASE_URL } from "@/lib/supabaseSafe";
import { authFetch } from "@/lib/authFetch";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { Database, Play, RefreshCw, TestTube2 } from "lucide-react";

type ServiceProvider = "kotak_neo" | "yahoo" | "fmp" | "alpha_vantage" | "nse" | "bse";

type Pipeline = {
  active_stocks: number;
  fundamentals_covered: number;
  fundamentals_failed: number;
  fundamentals_last_updated_at: string | null;
  scores_last_trade_date: string | null;
  scores_last_count: number | null;
  token_covered?: number | null;
  token_coverage_pct?: number | null;
} | null;

const SERVICE_META: Record<ServiceProvider, { name: string; role: string; fetches: string[]; primary?: boolean; needsKey?: boolean }> = {
  kotak_neo:     { name: "Kotak Neo",              role: "Primary quotes / EOD", fetches: ["Live LTP", "Depth", "Session-backed EOD"], primary: true },
  yahoo:         { name: "Yahoo Finance",          role: "Market data (fallback)", fetches: ["Quotes", "OHLC charts", "Fundamentals", "52-week range", "Indices"] },
  fmp:           { name: "Financial Modeling Prep",role: "Fundamentals (fallback)", fetches: ["Market cap", "PE / PB / ROE / ROCE", "Balance sheet", "Cash flow"], needsKey: true },
  alpha_vantage: { name: "Alpha Vantage",          role: "Technicals (fallback)",   fetches: ["SMA / EMA", "RSI", "MACD", "ADX / ATR", "Bollinger"], needsKey: true },
  nse:           { name: "NSE",                    role: "Exchange data",           fetches: ["Market status", "Index constituents", "Bulk / block deals", "Corporate actions"] },
  bse:           { name: "BSE",                    role: "Exchange data",           fetches: ["Corporate actions", "Announcements", "Circulars"] },
};

const PROVIDER_ORDER: ServiceProvider[] = ["kotak_neo", "yahoo", "fmp", "alpha_vantage", "nse", "bse"];

function timeAgo(ts: string | null): string {
  if (!ts) return "never";
  const d = new Date(ts).getTime();
  if (Number.isNaN(d)) return "—";
  const s = Math.max(0, Math.round((Date.now() - d) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function callFn(name: string, body: Record<string, unknown>) {
  const url = `${SAFE_SUPABASE_URL}/functions/v1/${name}`;
  const r = await authFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error ?? r.statusText);
  return j;
}

export default function SystemDataConfig() {
  const nav = useNavigate();
  const push = useUi((s) => s.push);
  const qc = useQueryClient();

  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<ServiceProvider, { ok: boolean; detail: string | null; testedAt: string } | null>>({
    kotak_neo: null, yahoo: null, fmp: null, alpha_vantage: null, nse: null, bse: null,
  });
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // Route is admin-gated in Config.tsx, so we don't repeat the check here.
  const { data: pipeline, isLoading } = useQuery({
    queryKey: ["market", "pipeline-status"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("market_pipeline_status").select("*").maybeSingle();
      if (error) throw error;
      return data as Pipeline;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const testProvider = async (prov: ServiceProvider) => {
    if (busy) return;
    setBusy(`test-${prov}`);
    try {
      const r = await callFn("market-test-connection", { provider: prov });
      const entry = { ok: !!r?.ok, detail: r?.detail ?? null, testedAt: new Date().toISOString() };
      setStatus((s) => ({ ...s, [prov]: entry }));
      push(r?.ok ? `${SERVICE_META[prov].name} OK` : `${SERVICE_META[prov].name} failed${r?.detail ? `: ${r.detail}` : ""}`, r?.ok ? "ok" : "err");
    } catch (e) {
      const msg = toSafeError(e, "Test failed").message;
      setStatus((s) => ({ ...s, [prov]: { ok: false, detail: msg, testedAt: new Date().toISOString() } }));
      push(msg, "err");
    } finally { if (mounted.current) setBusy(null); }
  };

  const trigger = async (fn: string, label: string, chunked = false) => {
    if (busy) return;
    setBusy(fn);
    try {
      if (!chunked) {
        const { error } = await supabase.functions.invoke(fn, { body: {} });
        if (error) throw error;
      } else {
        for (let i = 0; i < 30; i++) {
          const { data, error } = await supabase.functions.invoke(fn, { body: {} });
          if (error) throw error;
          if ((data as any)?.drained) break;
        }
      }
      push(`${label} complete`, "ok");
      await qc.invalidateQueries({ queryKey: ["market"] });
    } catch (e) { push(`${label} failed: ${(e as Error).message}`, "err"); }
    finally { if (mounted.current) setBusy(null); }
  };

  const total = pipeline?.active_stocks ?? 0;
  const fundOk = pipeline?.fundamentals_covered ?? 0;
  const fundFailed = pipeline?.fundamentals_failed ?? 0;
  const fundPct = total ? Math.round((fundOk / total) * 100) : 0;
  const tokenCovered = pipeline?.token_covered ?? 0;
  const tokenPct = pipeline?.token_coverage_pct ?? (total ? Math.round((tokenCovered / total) * 100) : 0);

  const stat: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, padding: "10px 12px", border: "1px solid var(--edge)", background: "rgba(53,214,237,0.03)" };
  const statLabel: React.CSSProperties = { fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--text-muted)" };
  const statValue: React.CSSProperties = { fontFamily: "var(--font-hud)", fontSize: 18, color: "var(--text)" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%", minHeight: 0, overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button onClick={() => nav("/config")} className="hud-label"
          style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: "4px 6px" }}>← config</button>
      </div>

      <HudPanel title="Data Providers (System)" index="PRV" live="ok" bodyClass="overflow-visible">
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>
          Shared providers powering the app for every user. Kotak Neo is primary; the rest are fallbacks.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {PROVIDER_ORDER.map((prov) => {
            const meta = SERVICE_META[prov];
            const st = status[prov];
            const label = st ? (st.ok ? "reachable" : "failed") : meta.needsKey ? "untested" : "available";
            const tone: "ok" | "warn" | "err" | "neutral" = st ? (st.ok ? "ok" : "err") : meta.needsKey ? "warn" : "neutral";
            return (
              <div key={prov} style={{ border: "1px solid var(--edge)", borderRadius: 4, padding: "7px 10px", background: "rgba(255,255,255,0.015)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "var(--font-hud)", fontSize: 14, color: "var(--text)", letterSpacing: "0.04em" }}>{meta.name}</span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.16em" }}>{meta.role}</span>
                  {meta.primary && <Chip tone="accent">primary</Chip>}
                  <Chip tone={tone}>{label}</Chip>
                  <span style={{ marginLeft: "auto" }}>
                    <Btn size="sm" onClick={() => testProvider(prov)} disabled={busy !== null}>
                      <TestTube2 size={11} style={{ marginRight: 4 }} />{busy === `test-${prov}` ? "testing…" : "Test"}
                    </Btn>
                  </span>
                </div>
                <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-muted)" }}>{meta.fetches.join(" · ")}</div>
                {st && !st.ok && st.detail && <div style={{ marginTop: 3, fontSize: 11, color: "var(--danger)" }}>Last error: {st.detail}</div>}
                {st && <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-dim)" }}>Last test: {new Date(st.testedAt).toLocaleTimeString()}</div>}
              </div>
            );
          })}
        </div>
      </HudPanel>

      <HudPanel title="Market Data Pipeline" index="MKT" live={isLoading ? "warn" : "ok"} bodyClass="overflow-visible">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 10 }}>
          <div style={stat}>
            <div style={statLabel}>Active Stocks</div>
            <div style={statValue}>{total}</div>
          </div>
          <div style={stat}>
            <div style={statLabel}>Fundamentals</div>
            <div style={statValue}>{fundOk} <span style={{ fontSize: 12, color: "var(--text-muted)" }}>/ {total}</span></div>
            <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
              <Chip tone={fundPct >= 95 ? "ok" : fundPct >= 80 ? "warn" : "err"}>{fundPct}%</Chip>
              {fundFailed > 0 && <Chip tone="err">{fundFailed} fail</Chip>}
            </div>
          </div>
          <div style={stat}>
            <div style={statLabel}>Fund. Last Sync</div>
            <div style={statValue}>{timeAgo(pipeline?.fundamentals_last_updated_at ?? null)}</div>
          </div>
          <div style={stat}>
            <div style={statLabel}>Scores Trade Date</div>
            <div style={statValue}>{pipeline?.scores_last_trade_date ?? "—"}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{pipeline?.scores_last_count ?? 0} rows</div>
          </div>
          <div style={stat}>
            <div style={statLabel}>Kotak Token Coverage</div>
            <div style={statValue}>{tokenCovered} <span style={{ fontSize: 12, color: "var(--text-muted)" }}>/ {total}</span></div>
            <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
              <Chip tone={tokenPct >= 90 ? "ok" : tokenPct >= 70 ? "warn" : "err"}>{tokenPct}%</Chip>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--edge)", display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="hud-label" style={{ color: "var(--accent)", fontSize: 11 }}>Force Resync</div>
          <div style={{ fontSize: 12, color: "var(--text-dim, var(--text))", lineHeight: 1.5 }}>
            Pipeline runs automatically via server crons and a silent background sync. Use these only if data looks stale.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="hud-btn" data-variant="ghost" data-size="sm" disabled={busy !== null}
              onClick={() => trigger("market-nse-master-sync", "NSE master")}>
              <Database size={11} style={{ marginRight: 6, verticalAlign: "middle" }} />
              {busy === "market-nse-master-sync" ? "syncing…" : "Sync NSE master (universe)"}
            </button>
            <button className="hud-btn" data-variant="ghost" data-size="sm" disabled={busy !== null}
              onClick={() => trigger("market-nse-bhavcopy-sync", "NSE bhavcopy")}>
              <Database size={11} style={{ marginRight: 6, verticalAlign: "middle" }} />
              {busy === "market-nse-bhavcopy-sync" ? "syncing…" : "Sync NSE bhavcopy (EOD)"}
            </button>
            <button className="hud-btn" data-variant="ghost" data-size="sm" disabled={busy !== null}
              onClick={() => trigger("market-shares-outstanding-sync", "Shares outstanding")}>
              <Database size={11} style={{ marginRight: 6, verticalAlign: "middle" }} />
              {busy === "market-shares-outstanding-sync" ? "syncing…" : "Sync shares outstanding"}
            </button>
            <button className="hud-btn" data-variant="ghost" data-size="sm" disabled={busy !== null}
              onClick={() => trigger("market-fundamentals-global-sync", "Fundamentals", true)}>
              <Database size={11} style={{ marginRight: 6, verticalAlign: "middle" }} />
              {busy === "market-fundamentals-global-sync" ? "syncing…" : "Resync fundamentals"}
            </button>
            <button className="hud-btn" data-variant="ghost" data-size="sm" disabled={busy !== null}
              onClick={() => trigger("market-pipeline-eod", "EOD technicals", true)}>
              <Play size={11} style={{ marginRight: 6, verticalAlign: "middle" }} />
              {busy === "market-pipeline-eod" ? "syncing…" : "Recompute technicals"}
            </button>
            <button className="hud-btn" data-variant="ghost" data-size="sm" disabled={busy !== null}
              onClick={() => trigger("market-pipeline-aggregates", "Aggregates")}>
              <RefreshCw size={11} style={{ marginRight: 6, verticalAlign: "middle" }} />
              {busy === "market-pipeline-aggregates" ? "syncing…" : "Recompute breadth"}
            </button>
            <button className="hud-btn" data-variant="ghost" data-size="sm" disabled={busy !== null}
              onClick={() => trigger("market-indices", "Index refresh")}>
              {busy === "market-indices" ? "syncing…" : "Refresh indices"}
            </button>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Verify in <Link to="/market/screener" style={{ color: "var(--accent)" }}>Screener</Link> or <Link to="/market" style={{ color: "var(--accent)" }}>Dashboard</Link>.
          </div>
        </div>
      </HudPanel>
    </div>
  );
}
