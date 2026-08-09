// Admin Config — app-wide config for the market data pipeline, providers,
// storage quota and users. One tab bar lives in Config.tsx; this file renders
// the content for a single tab (`view`).
// Per-user broker connections live at /market/settings, not here.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import HudPanel from "@/components/hud/HudPanel";
import { Chip } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { useUi } from "@/store/uiStore";
import { Database, Play, RefreshCw } from "lucide-react";
import DatabaseStoragePanel from "@/components/config/DatabaseStoragePanel";
import ProvidersPanel from "@/components/config/ProvidersPanel";

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

export type ConfigView = "feeds" | "pipeline" | "storage";

export default function SystemDataConfig({ view = "feeds" }: { view?: ConfigView }) {
  const push = useUi((s) => s.push);
  const qc = useQueryClient();

  const [busy, setBusy] = useState<string | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Route is admin-gated in Config.tsx, so we don't repeat the check here.
  const { data: pipeline, isLoading } = useQuery({
    queryKey: ["market", "pipeline-status"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("market_pipeline_status")
        .select("active_stocks,fundamentals_covered,fundamentals_failed,fundamentals_last_updated_at,scores_last_trade_date,scores_last_count,token_covered,token_coverage_pct")
        .maybeSingle();

      if (error) throw error;
      return data as Pipeline;
    },
    enabled: view === "pipeline",
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

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
  const fundPct = total > 0 ? Math.min(100, Math.round((fundOk / total) * 100)) : 0;
  const tokenCovered = pipeline?.token_covered ?? 0;
  const tokenPct = pipeline?.token_coverage_pct ?? (total > 0 ? Math.round((tokenCovered / total) * 100) : 0);

  const stat: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2, padding: "6px 8px", border: "1px solid var(--edge)", background: "rgba(53,214,237,0.03)" };
  const statLabel: React.CSSProperties = { fontFamily: "var(--font-hud)", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-muted)" };
  const statValue: React.CSSProperties = { fontFamily: "var(--font-hud)", fontSize: 15, color: "var(--text)" };

  const SYNCS: { fn: string; label: string; text: string; chunked?: boolean; icon: typeof Database }[] = [
    { fn: "market-nse-master-sync", label: "NSE master", text: "NSE master (universe)", icon: Database },
    { fn: "market-nse-bhavcopy-sync", label: "NSE bhavcopy", text: "NSE bhavcopy (EOD)", icon: Database },
    { fn: "market-shares-outstanding-sync", label: "Shares outstanding", text: "Shares outstanding", icon: Database },
    { fn: "market-fundamentals-global-sync", label: "Fundamentals", text: "Fundamentals", chunked: true, icon: Database },
    { fn: "market-pipeline-eod", label: "EOD technicals", text: "Technicals", chunked: true, icon: Play },
    { fn: "market-pipeline-aggregates", label: "Aggregates", text: "Breadth", icon: RefreshCw },
    { fn: "market-indices", label: "Index refresh", text: "Indices", icon: RefreshCw },
  ];

  if (view === "feeds") return <ProvidersPanel />;

  if (view === "storage") {
    return (
      <div style={{ width: "100%", maxWidth: 860 }}>
        <DatabaseStoragePanel />
      </div>
    );
  }

  return (
    <div style={{ width: "100%", maxWidth: 860 }}>
      <HudPanel title="Market Data Pipeline" index="MKT" live={isLoading ? "warn" : "ok"} bodyClass="overflow-visible">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
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

        <div style={{ marginTop: 8, paddingTop: 6, borderTop: "1px solid var(--edge)", display: "flex", gap: 6, flexWrap: "wrap" }}>
          {SYNCS.map(({ fn, label, text, chunked, icon: Icon }) => (
            <button key={fn} className="hud-btn" data-variant="ghost" data-size="sm" disabled={busy !== null}
              onClick={() => trigger(fn, label, chunked)}>
              <Icon size={11} style={{ marginRight: 6, verticalAlign: "middle" }} />
              {busy === fn ? "syncing…" : text}
            </button>
          ))}
        </div>
      </HudPanel>
    </div>
  );
}
