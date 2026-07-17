// Market Dashboard — "what are the best stocks to buy today?"
// Indices + real breadth, sector strength, top breakout stocks, pre-breakout watch,
// watchlist pulse, AI daily insight.
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { DataTable, fmtInt, fmtNum, PctCell } from "@/components/hud/DataTable";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { supabase } from "@/integrations/supabase/client";
import { callMarketFn } from "@/lib/market/api";
import { useBreadth, useIndices, useMarketSettings, useSectorStrength, useStockScores } from "@/lib/market/hooks";
import { useQuery } from "@tanstack/react-query";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { RefreshCw, Sparkles } from "lucide-react";
import type { StockScore } from "@/lib/market/types";

export default function MarketDashboard() {
  const push = useUi((s) => s.push);
  const nav = useNavigate();
  const [insight, setInsight] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const { data: indicesData, refetch: refetchIndices, isFetching: indicesFetching } = useIndices();
  const { data: breadth } = useBreadth();
  const { data: sectors = [] } = useSectorStrength();
  const { data: settings = [] } = useMarketSettings();
  const { data: topBreakouts = [] } = useStockScores({ orderBy: "breakout_score", limit: 15 });
  const { data: preBreakouts = [] } = useStockScores({ orderBy: "prebreakout_score", limit: 10 });

  const { data: counts } = useQuery({
    queryKey: ["market", "dash-counts"],
    queryFn: async () => {
      const [{ count: hc }, { count: wc }, watchItems] = await Promise.all([
        supabase.from("market_holdings").select("id", { head: true, count: "exact" }),
        supabase.from("market_watchlist_items").select("id", { head: true, count: "exact" }),
        supabase.from("market_watchlist_items").select("symbol"),
      ]);
      return { holdings: hc ?? 0, watchlist: wc ?? 0, watchSymbols: (watchItems.data ?? []).map((r: any) => r.symbol as string) };
    },
  });

  // Watchlist pulse from scores
  const watchSet = useMemo(() => new Set(counts?.watchSymbols ?? []), [counts]);
  const { data: allScores = [] } = useStockScores({ orderBy: "breakout_score", limit: 1000 });
  const watchPulse = useMemo(() => {
    const w = allScores.filter((s) => watchSet.has(s.symbol));
    return {
      ready: w.filter((s) => (s.breakout_score ?? 0) >= 70).length,
      near: w.filter((s) => (s.prebreakout_score ?? 0) >= 70).length,
      weak: w.filter((s) => s.breakout_score != null && s.breakout_score < 40).length,
    };
  }, [allScores, watchSet]);

  const connected = settings.find((s) => s.connection_status === "connected")?.active_provider ?? null;

  const loadInsight = async () => {
    setBusy("insight");
    try {
      const r = await callMarketFn<{ summary?: string }>("market-morning-insight");
      setInsight(r?.summary ?? "");
    } catch (e) { push(toSafeError(e, "AI insight failed").message, "err"); }
    finally { setBusy(null); }
  };

  const breakoutColumns = useMemo<ColumnDef<StockScore, any>[]>(() => [
    {
      header: "Symbol", accessorKey: "symbol",
      cell: ({ row }) => (
        <span>
          <span style={{ color: "var(--accent)" }}>{row.original.symbol}</span>
          {row.original.sector && <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 10 }}>{row.original.sector}</span>}
        </span>
      ),
    },
    { header: "Price", accessorKey: "close", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue()) },
    { header: "Chg %", accessorKey: "change_pct", meta: { align: "right" }, cell: ({ getValue }) => <PctCell value={getValue()} /> },
    { header: "RVol", accessorKey: "rel_volume", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue(), 1) },
    { header: "RSI", accessorKey: "rsi14", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue(), 0) },
    { header: "Vol", accessorKey: "volume", meta: { align: "right" }, cell: ({ getValue }) => fmtInt(getValue()) },
    {
      header: "Breakout", accessorKey: "breakout_score", meta: { align: "right" },
      cell: ({ row }) => <ScoreBadge score={row.original.breakout_score} components={row.original.score_components?.breakout} label="breakout components" />,
    },
    {
      header: "Pre-BO", accessorKey: "prebreakout_score", meta: { align: "right" },
      cell: ({ row }) => <ScoreBadge score={row.original.prebreakout_score} components={row.original.score_components?.prebreakout} label="pre-breakout components" />,
    },
    {
      header: "Entry ≈", id: "entry", meta: { align: "right" },
      accessorFn: (r) => r.resistance_level ?? r.close,
      cell: ({ getValue }) => fmtNum(getValue()),
    },
  ], []);

  const pipelineEmpty = topBreakouts.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HudPanel title="Market Summary" index="MK.D1" live={indicesFetching ? "warn" : "ok"} actions={
        <Btn size="sm" onClick={() => refetchIndices()} disabled={indicesFetching}>
          <RefreshCw size={11} style={{ marginRight: 4 }} /> {indicesFetching ? "refreshing…" : "refresh"}
        </Btn>
      }>
        {!connected && (
          <div style={{ marginBottom: 12, padding: 10, border: "1px dashed var(--edge)", fontSize: 12, color: "var(--text-dim)" }}>
            Using Yahoo Finance.{" "}
            <Link to="/market/settings" style={{ color: "var(--accent)" }}>Connect Kotak Neo</Link> for live NSE quotes and portfolio sync.
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 8 }}>
          {(indicesData?.quotes ?? []).map((q) => (
            <div key={q.symbol} style={{ padding: 10, border: "1px solid var(--edge)" }}>
              <div className="hud-label" style={{ color: "var(--text-dim)" }}>{q.name}</div>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 18 }}>
                {Number(q.price).toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </div>
              <div style={{ fontSize: 11, color: (q.change_pct ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }}>
                {q.change_pct == null ? "—" : `${q.change_pct >= 0 ? "+" : ""}${q.change_pct.toFixed(2)}%`}
              </div>
            </div>
          ))}
        </div>
        {breadth && (
          <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Chip tone={breadth.regime === "bullish" ? "ok" : breadth.regime === "bearish" ? "err" : "neutral"}>
              regime: {breadth.regime ?? "unknown"}
            </Chip>
            {breadth.advances != null && <Chip tone="ok">adv {breadth.advances}</Chip>}
            {breadth.declines != null && <Chip tone="err">dec {breadth.declines}</Chip>}
            {breadth.pct_above_ema50 != null && <Chip tone="neutral">&gt;50EMA {Math.round(breadth.pct_above_ema50)}%</Chip>}
            {breadth.pct_above_ema200 != null && <Chip tone="neutral">&gt;200EMA {Math.round(breadth.pct_above_ema200)}%</Chip>}
            {breadth.avg_rsi != null && <Chip tone="neutral">avg RSI {Math.round(breadth.avg_rsi)}</Chip>}
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>as of {breadth.trade_date}</span>
          </div>
        )}
      </HudPanel>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, alignItems: "start" }}>
        <HudPanel title="Top Breakout Stocks" index="MK.D2">
          <DataTable
            columns={breakoutColumns}
            data={topBreakouts}
            onRowClick={(r) => nav(`/market/analysis/${r.symbol}`)}
            initialSort={[{ id: "breakout_score", desc: true }]}
            emptyLabel="no scores yet"
            emptyHint="run the data pipeline from Settings, or wait for the evening cron"
          />
        </HudPanel>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <HudPanel title="Sector Strength" index="MK.D3">
            {sectors.length === 0 ? (
              <div className="hud-label" style={{ color: "var(--text-dim)" }}>pipeline pending</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 260, overflow: "auto" }}>
                {sectors.slice(0, 12).map((s) => (
                  <div key={s.sector} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "3px 0", borderBottom: "1px solid var(--edge)" }}>
                    <span style={{ color: (s.strength_rank ?? 99) <= 3 ? "var(--ok)" : "var(--text-dim)" }}>
                      #{s.strength_rank} {s.sector}
                    </span>
                    <span style={{ color: (s.avg_change_pct ?? 0) >= 0 ? "var(--ok)" : "var(--danger)", fontVariantNumeric: "tabular-nums" }}>
                      {s.avg_change_pct == null ? "—" : `${s.avg_change_pct >= 0 ? "+" : ""}${s.avg_change_pct.toFixed(2)}%`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </HudPanel>

          <HudPanel title="Portfolio Pulse" index="MK.D4">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <StatTile label="Holdings" value={String(counts?.holdings ?? 0)} to="/market/holdings" />
              <StatTile label="Watchlist" value={String(counts?.watchlist ?? 0)} to="/market/watchlist" />
              <StatTile label="Ready to buy" value={pipelineEmpty ? "—" : String(watchPulse.ready)} tone="ok" />
              <StatTile label="Near breakout" value={pipelineEmpty ? "—" : String(watchPulse.near)} tone="accent" />
              <StatTile label="Weak stocks" value={pipelineEmpty ? "—" : String(watchPulse.weak)} tone="err" />
            </div>
          </HudPanel>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "start" }}>
        <HudPanel title="Pre-Breakout Watch" index="MK.D5">
          {preBreakouts.filter((s) => (s.prebreakout_score ?? 0) > 0).length === 0 ? (
            <div className="hud-label" style={{ color: "var(--text-dim)" }}>no coiled setups yet — pipeline pending</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {preBreakouts.filter((s) => (s.prebreakout_score ?? 0) > 0).map((s) => (
                <div key={s.id} onClick={() => nav(`/market/analysis/${s.symbol}`)}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid var(--edge)", cursor: "pointer", fontSize: 12 }}>
                  <span>
                    <span style={{ color: "var(--accent)" }}>{s.symbol}</span>
                    <span style={{ display: "inline-flex", gap: 4, marginLeft: 8 }}>
                      {s.bb_squeeze && <Chip tone="accent">squeeze</Chip>}
                      {s.higher_lows && <Chip tone="ok">HL</Chip>}
                      {s.near_resistance && <Chip tone="warn">@res</Chip>}
                    </span>
                  </span>
                  <ScoreBadge score={s.prebreakout_score} components={s.score_components?.prebreakout} label="pre-breakout components" />
                </div>
              ))}
            </div>
          )}
        </HudPanel>

        <HudPanel title="AI Daily Insight" index="MK.D6" actions={
          <Btn size="sm" onClick={loadInsight} disabled={busy !== null}>
            <Sparkles size={11} style={{ marginRight: 4 }} /> {busy === "insight" ? "generating…" : "generate"}
          </Btn>
        }>
          {insight
            ? <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{insight}</div>
            : <div className="hud-label" style={{ color: "var(--text-dim)" }}>Tap generate — JARVIS reads today's breadth, your holdings and watchlist, and briefs you.</div>}
        </HudPanel>
      </div>
    </div>
  );
}

function StatTile({ label, value, to, tone }: { label: string; value: string; to?: string; tone?: "ok" | "err" | "accent" }) {
  const color = tone === "ok" ? "var(--ok)" : tone === "err" ? "var(--danger)" : "var(--accent)";
  const body = (
    <div style={{ padding: 10, border: "1px solid var(--edge)", height: "100%" }}>
      <div className="hud-label" style={{ color: "var(--text-dim)" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 22, color }}>{value}</div>
    </div>
  );
  return to ? <Link to={to} style={{ textDecoration: "none" }}>{body}</Link> : body;
}
