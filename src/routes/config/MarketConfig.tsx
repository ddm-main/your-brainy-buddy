// Market data pipeline health + manual resync controls.
// Moved out of the Screener toolbar into Config to keep the trading UI focused.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import HudPanel from "@/components/hud/HudPanel";
import { Chip } from "@/components/hud/HudControls";
import { supabase } from "@/integrations/supabase/client";
import { useUi } from "@/store/uiStore";
import { Database } from "lucide-react";

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

export default function MarketConfig() {
  const nav = useNavigate();
  const push = useUi((s) => s.push);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<null | "fund" | "eod" | "agg" | "nse" | "master" | "shares">(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

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

  const trigger = async (
    fn: "market-fundamentals-global-sync" | "market-pipeline-eod" | "market-pipeline-aggregates" | "market-nse-bhavcopy-sync" | "market-nse-master-sync" | "market-shares-outstanding-sync",
    label: string,
    key: "fund" | "eod" | "agg" | "nse" | "master" | "shares",
  ) => {
    if (busy) return;
    setBusy(key);
    const isChunked = fn === "market-fundamentals-global-sync" || fn === "market-pipeline-eod";
    try {
      if (!isChunked) {
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
    } catch (e) {
      push(`${label} failed: ${(e as Error).message}`, "err");
    } finally {
      if (mounted.current) setBusy(null);
    }
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
    <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          onClick={() => nav("/config")}
          className="hud-label"
          style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: "4px 6px" }}
        >← config</button>
      </div>

      <HudPanel title="Market Data Pipeline" index="MKT" live={isLoading ? "warn" : "ok"} bodyClass="overflow-auto">
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
              onClick={() => trigger("market-nse-master-sync", "NSE master", "master")}>
              <Database size={11} style={{ marginRight: 6, verticalAlign: "middle" }} />
              {busy === "master" ? "syncing…" : "Sync NSE master (universe expansion)"}
            </button>
            <button className="hud-btn" data-variant="ghost" data-size="sm" disabled={busy !== null}
              onClick={() => trigger("market-nse-bhavcopy-sync", "NSE bhavcopy", "nse")}>
              <Database size={11} style={{ marginRight: 6, verticalAlign: "middle" }} />
              {busy === "nse" ? "syncing…" : "Sync NSE bhavcopy (authoritative EOD)"}
            </button>
            <button className="hud-btn" data-variant="ghost" data-size="sm" disabled={busy !== null}
              onClick={() => trigger("market-shares-outstanding-sync", "Shares outstanding", "shares")}>
              <Database size={11} style={{ marginRight: 6, verticalAlign: "middle" }} />
              {busy === "shares" ? "syncing…" : "Sync shares outstanding (true mcap)"}
            </button>
            <button className="hud-btn" data-variant="ghost" data-size="sm" disabled={busy !== null}
              onClick={() => trigger("market-fundamentals-global-sync", "Fundamentals", "fund")}>
              <Database size={11} style={{ marginRight: 6, verticalAlign: "middle" }} />
              {busy === "fund" ? "syncing…" : "Resync fundamentals"}
            </button>
            <button className="hud-btn" data-variant="ghost" data-size="sm" disabled={busy !== null}
              onClick={() => trigger("market-pipeline-eod", "EOD technicals", "eod")}>
              {busy === "eod" ? "syncing…" : "Recompute technicals"}
            </button>
            <button className="hud-btn" data-variant="ghost" data-size="sm" disabled={busy !== null}
              onClick={() => trigger("market-pipeline-aggregates", "Aggregates", "agg")}>
              {busy === "agg" ? "syncing…" : "Recompute breadth"}
            </button>
          </div>
        </div>
      </HudPanel>
    </div>
  );
}
