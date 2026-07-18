// Market Dashboard — "what are the best stocks to buy today?"
// Indices + real breadth, sector strength, top breakout stocks, pre-breakout watch,
// watchlist pulse, AI daily insight.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { DataTable, fmtInt, fmtNum, PctCell } from "@/components/hud/DataTable";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { supabase } from "@/integrations/supabase/client";
import { callMarketFn } from "@/lib/market/api";
import { useBreadth, useCandles, useIndices, useMarketSettings, useSectorStrength, useStockScores } from "@/lib/market/hooks";
import { CandleChart } from "@/components/market/CandleChart";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { RefreshCw, Sparkles, X } from "lucide-react";
import type { IndexQuote, Quote, StockScore } from "@/lib/market/types";
import { holdingPnl, quoteKey, sumNullable } from "@/lib/market/pnl";

export default function MarketDashboard() {
  const push = useUi((s) => s.push);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [insight, setInsight] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [selIdx, setSelIdx] = useState<IndexQuote | null>(null);

  useEffect(() => {
    const handler = () => qc.invalidateQueries({ queryKey: ["market"] });
    window.addEventListener("market:refresh", handler);
    return () => window.removeEventListener("market:refresh", handler);
  }, [qc]);


  const { data: indicesData, refetch: refetchIndices, isFetching: indicesFetching } = useIndices();
  const { data: breadth } = useBreadth();
  const { data: sectors = [] } = useSectorStrength();
  const { data: settings = [] } = useMarketSettings();
  const { data: topBreakouts = [] } = useStockScores({ orderBy: "breakout_score", limit: 15 });
  const { data: preBreakouts = [] } = useStockScores({ orderBy: "prebreakout_score", limit: 10 });

  const { data: counts } = useQuery({
    queryKey: ["market", "dash-counts"],
    queryFn: async () => {
      const [{ count: wc }, watchItems, holdingRows] = await Promise.all([
        supabase.from("market_watchlist_items").select("id", { head: true, count: "exact" }),
        supabase.from("market_watchlist_items").select("symbol"),
        supabase.from("market_holdings").select("symbol,exchange,quantity,avg_price"),
      ]);
      return {
        holdings: (holdingRows.data ?? []).length,
        watchlist: wc ?? 0,
        watchSymbols: (watchItems.data ?? []).map((r: any) => r.symbol as string),
        holdingRows: (holdingRows.data ?? []) as Array<{ symbol: string; exchange: string; quantity: number; avg_price: number }>,
      };
    },
  });

  // Portfolio day P&L — quote the held symbols (refreshes with the 60s quote poll).
  const { data: pfQuotes } = useQuery({
    queryKey: ["market", "dash-pf-quotes", (counts?.holdingRows ?? []).map((h) => h.symbol).join(",")],
    queryFn: async () => {
      const keys = Array.from(new Set((counts!.holdingRows).map((h) => `${h.exchange}:${h.symbol}`)));
      return callMarketFn<{ quotes: Quote[] }>("market-quotes", { symbols: keys });
    },
    enabled: (counts?.holdingRows.length ?? 0) > 0,
    refetchInterval: 60_000,
  });
  const pf = useMemo(() => {
    const rows = counts?.holdingRows ?? [];
    if (rows.length === 0) return null;
    const byKey = new Map((pfQuotes?.quotes ?? []).map((q) => [quoteKey(q.exchange, q.symbol), q]));
    let invested = 0, current = 0;
    const dayPnls: Array<number | null> = [];
    for (const h of rows) {
      const calc = holdingPnl({ quantity: h.quantity, avgPrice: h.avg_price, quote: byKey.get(quoteKey(h.exchange, h.symbol)) });
      invested += calc.invested;
      current += calc.current;
      dayPnls.push(calc.todayPnl);
    }
    const day = sumNullable(dayPnls);
    return { invested, current, pnl: current - invested, day };
  }, [counts, pfQuotes]);

  // Watchlist pulse — intersect with already-fetched top/pre breakout scores;
  // avoids fetching 1000 rows just to compute three counts.
  const watchSet = useMemo(() => new Set(counts?.watchSymbols ?? []), [counts]);
  const watchPulse = useMemo(() => {
    const bySymbol = new Map<string, StockScore>();
    for (const s of [...topBreakouts, ...preBreakouts]) if (!bySymbol.has(s.symbol)) bySymbol.set(s.symbol, s);
    const w = Array.from(bySymbol.values()).filter((s) => watchSet.has(s.symbol));
    return {
      ready: w.filter((s) => (s.breakout_score ?? 0) >= 70).length,
      near: w.filter((s) => (s.prebreakout_score ?? 0) >= 70).length,
      weak: w.filter((s) => s.breakout_score != null && s.breakout_score < 40).length,
    };
  }, [topBreakouts, preBreakouts, watchSet]);

  const connected = settings.find((s) => s.connection_status === "connected")?.active_provider ?? null;

  const loadInsight = async () => {
    setBusy("insight");
    try {
      const r = await callMarketFn<{ summary?: string }>("market-morning-insight");
      setInsight(r?.summary ?? "");
    } catch (e) { push(toSafeError(e, "AI insight failed").message, "err"); }
    finally { setBusy(null); }
  };

  // Bootstrap the data pipeline on demand so the dashboard fills without
  // waiting for the evening cron. Runs the same steps cron would run.
  const primeData = async () => {
    setBusy("prime");
    const steps: Array<{ label: string; fn: string }> = [
      { label: "Syncing scrip master", fn: "market-scrips-sync" },
      { label: "Running EOD pipeline", fn: "market-pipeline-eod" },
      { label: "Computing aggregates", fn: "market-pipeline-aggregates" },
      { label: "Refreshing indices", fn: "market-indices" },
    ];
    try {
      for (const s of steps) {
        push(`${s.label}…`, "info");
        await callMarketFn(s.fn);
      }
      push("Market data primed", "ok");
      await refetchIndices();
      // Invalidate the react-query caches the dashboard reads from.
      window.dispatchEvent(new Event("market:refresh"));
    } catch (e) {
      push(toSafeError(e, "Prime failed").message, "err");
    } finally {
      setBusy(null);
    }
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
      <HudPanel flow title="Market Summary" index="MK.D1" live={indicesFetching ? "warn" : "ok"} actions={
        <div style={{ display: "flex", gap: 6 }}>
          <Btn size="sm" onClick={primeData} disabled={busy !== null}>
            <Sparkles size={11} style={{ marginRight: 4 }} /> {busy === "prime" ? "priming…" : "prime data"}
          </Btn>
          <Btn size="sm" onClick={() => refetchIndices()} disabled={indicesFetching}>
            <RefreshCw size={11} style={{ marginRight: 4 }} /> {indicesFetching ? "refreshing…" : "refresh"}
          </Btn>
        </div>
      }>
        {!connected && (
          <div style={{ marginBottom: 12, padding: 10, border: "1px dashed var(--edge)", fontSize: 12, color: "var(--text-dim)" }}>
            Using Yahoo Finance.{" "}
            <Link to="/market/settings" style={{ color: "var(--accent)" }}>Connect Kotak Neo</Link> for live NSE quotes and portfolio sync.
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 8 }}>
          {(indicesData?.quotes ?? []).map((q) => (
            <button
              key={q.symbol}
              onClick={() => setSelIdx(q)}
              title={`${q.name} — view details`}
              style={{
                padding: 10, border: "1px solid var(--edge)", background: "transparent",
                textAlign: "left", cursor: "pointer", borderRadius: 2,
                transition: "border-color 120ms, background 120ms",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--edge-strong)"; e.currentTarget.style.background = "rgba(53,214,237,0.05)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--edge)"; e.currentTarget.style.background = "transparent"; }}
            >
              <div className="hud-label" style={{ color: "var(--text-dim)" }}>{q.name}</div>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 18, color: "var(--text)" }}>
                {Number(q.price).toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </div>
              <div style={{ fontSize: 11, color: (q.change_pct ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }}>
                {q.change_pct == null ? "—" : `${q.change_pct >= 0 ? "+" : ""}${q.change_pct.toFixed(2)}%`}
              </div>
            </button>
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
        <HudPanel flow title="Top Breakout Stocks" index="MK.D2">
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
          <HudPanel flow title="Sector Strength" index="MK.D3">
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

          <HudPanel flow title="Portfolio Pulse" index="MK.D4">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <StatTile label="Holdings" value={String(counts?.holdings ?? 0)} to="/market/holdings" />
              <StatTile label="Watchlist" value={String(counts?.watchlist ?? 0)} to="/market/watchlist" />
              {pf && (
                <>
                  <StatTile label="Current value" value={`₹${Math.round(pf.current).toLocaleString("en-IN")}`} to="/market/holdings" />
                  <StatTile label="Today's P&L" value={pf.day == null ? "—" : `${pf.day >= 0 ? "+" : ""}₹${Math.round(pf.day).toLocaleString("en-IN")}`} tone={pf.day == null ? "accent" : pf.day >= 0 ? "ok" : "err"} />
                  <StatTile label="Total P&L" value={`${pf.pnl >= 0 ? "+" : ""}₹${Math.round(pf.pnl).toLocaleString("en-IN")}`} tone={pf.pnl >= 0 ? "ok" : "err"} />
                </>
              )}
              <StatTile label="Ready to buy" value={pipelineEmpty ? "—" : String(watchPulse.ready)} tone="ok" />
              <StatTile label="Near breakout" value={pipelineEmpty ? "—" : String(watchPulse.near)} tone="accent" />
              <StatTile label="Weak stocks" value={pipelineEmpty ? "—" : String(watchPulse.weak)} tone="err" />
            </div>
          </HudPanel>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "start" }}>
        <HudPanel flow title="Pre-Breakout Watch" index="MK.D5">
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

        <HudPanel flow title="AI Daily Insight" index="MK.D6" actions={
          <Btn size="sm" onClick={loadInsight} disabled={busy !== null}>
            <Sparkles size={11} style={{ marginRight: 4 }} /> {busy === "insight" ? "generating…" : "generate"}
          </Btn>
        }>
          {insight
            ? <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{insight}</div>
            : <div className="hud-label" style={{ color: "var(--text-dim)" }}>Tap generate — JARVIS reads today's breadth, your holdings and watchlist, and briefs you.</div>}
        </HudPanel>
      </div>

      {selIdx && <IndexDetailModal quote={selIdx} onClose={() => setSelIdx(null)} />}
    </div>
  );
}

function IndexDetailModal({ quote, onClose }: { quote: IndexQuote; onClose: () => void }) {
  const { data, isLoading } = useCandles(quote.symbol, "1D");
  const candles = data?.candles ?? [];

  const s = useMemo(() => {
    if (candles.length === 0) return null;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const window = candles.slice(-252); // ~1 trading year
    const hi52 = Math.max(...window.map((c) => c.high));
    const lo52 = Math.min(...window.map((c) => c.low));
    const vols = candles.slice(-20).map((c) => c.volume).filter((v) => v > 0);
    const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
    const prevClose = prev?.close ?? last.open;
    const dayAbs = last.close - prevClose;
    return {
      last, open: last.open, high: last.high, low: last.low, close: last.close,
      prevClose, dayAbs, dayPct: prevClose ? (dayAbs / prevClose) * 100 : 0,
      hi52, lo52, fromHi: hi52 ? ((last.close - hi52) / hi52) * 100 : 0,
      fromLo: lo52 ? ((last.close - lo52) / lo52) * 100 : 0,
      vol: last.volume, avgVol,
    };
  }, [candles]);

  const chgPct = quote.change_pct ?? s?.dayPct ?? null;

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "min(760px, 96vw)", maxHeight: "90vh", overflowY: "auto",
        background: "var(--bg)", border: "1px solid var(--edge-strong)",
        padding: 16, display: "flex", flexDirection: "column", gap: 12,
      }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div className="hud-label" style={{ color: "var(--accent)", letterSpacing: "0.2em" }}>{quote.name}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4 }}>
              <span style={{ fontFamily: "var(--font-display)", fontSize: 28 }}>
                {Number(quote.price).toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
              <span style={{ fontSize: 14, color: (chgPct ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }}>
                {chgPct == null ? "—" : `${chgPct >= 0 ? "+" : ""}${chgPct.toFixed(2)}%`}
                {s && <span style={{ marginLeft: 6 }}>({s.dayAbs >= 0 ? "+" : ""}{fmtNum(s.dayAbs)})</span>}
              </span>
            </div>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>{quote.symbol} · daily · EOD</div>
          </div>
          <button onClick={onClose} className="hud-btn focus-outline" data-variant="ghost" data-size="sm" title="Close">
            <X size={14} />
          </button>
        </div>

        {/* chart */}
        <div style={{ height: 320, border: "1px solid var(--edge)" }}>
          {isLoading ? (
            <div className="hud-label" style={{ padding: 24, textAlign: "center" }}>loading chart…</div>
          ) : candles.length === 0 ? (
            <div className="hud-label" style={{ padding: 24, textAlign: "center" }}>no chart data for this index</div>
          ) : (
            <CandleChart candles={candles} fill chartType="candles" indicators={{ ema20: true, ema50: true, volume: true }} />
          )}
        </div>

        {/* stats */}
        {s && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
            <IdxStat label="Open" value={fmtNum(s.open)} />
            <IdxStat label="Prev Close" value={fmtNum(s.prevClose)} />
            <IdxStat label="Day High" value={fmtNum(s.high)} />
            <IdxStat label="Day Low" value={fmtNum(s.low)} />
            <IdxStat label="52W High" value={fmtNum(s.hi52)} />
            <IdxStat label="52W Low" value={fmtNum(s.lo52)} />
            <IdxStat label="From 52W High" value={`${s.fromHi >= 0 ? "+" : ""}${s.fromHi.toFixed(2)}%`} tone={s.fromHi >= -5 ? "ok" : undefined} />
            <IdxStat label="From 52W Low" value={`${s.fromLo >= 0 ? "+" : ""}${s.fromLo.toFixed(2)}%`} tone="ok" />
            {s.vol > 0 && <IdxStat label="Volume" value={fmtInt(s.vol)} />}
            {s.avgVol > 0 && <IdxStat label="Avg Vol (20d)" value={fmtInt(s.avgVol)} />}
          </div>
        )}
      </div>
    </div>
  );
}

function IdxStat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "err" }) {
  const color = tone === "ok" ? "var(--ok)" : tone === "err" ? "var(--danger)" : "var(--text)";
  return (
    <div style={{ padding: "8px 10px", border: "1px solid var(--edge)" }}>
      <div className="hud-label" style={{ color: "var(--text-dim)" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 16, color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
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
