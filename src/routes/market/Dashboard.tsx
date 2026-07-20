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
import { useIndices, useIndexWatch, useIndexWatchMutations, useMarketSettings, useQuotes, useSectorStrength, useStockScores } from "@/lib/market/hooks";
import { ALL_PRESETS, GLOBAL_PRESETS, INDIAN_PRESETS, type IndexPreset } from "@/lib/market/indices";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { RefreshCw, Settings2, Sparkles, Trash2, X } from "lucide-react";
import type { Quote, StockScore } from "@/lib/market/types";
import { holdingPnl, quoteKey, sumNullable } from "@/lib/market/pnl";
import { isFreshTick, useLiveTickStore } from "@/lib/market/liveTickStore";

export default function MarketDashboard() {
  const push = useUi((s) => s.push);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [insight, setInsight] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);

  useEffect(() => {
    const handler = () => qc.invalidateQueries({ queryKey: ["market"] });
    window.addEventListener("market:refresh", handler);
    return () => window.removeEventListener("market:refresh", handler);
  }, [qc]);


  const { data: indicesData, refetch: refetchIndices, isFetching: indicesFetching } = useIndices();
  const { data: sectors = [] } = useSectorStrength();
  const { data: settings = [] } = useMarketSettings();
  const { data: topBreakouts = [] } = useStockScores({ orderBy: "breakout_score", limit: 15 });
  const { data: preBreakouts = [] } = useStockScores({ orderBy: "prebreakout_score", limit: 10 });

  // The scores above are EOD (recomputed once a day by the evening pipeline —
  // RSI/EMA/breakout scoring is inherently a daily-bar concept, same as any
  // trading platform). But the displayed price/change% shouldn't sit frozen at
  // yesterday's close all session — overlay live quotes on top of them.
  const scoreKeys = useMemo(
    () => Array.from(new Set([...topBreakouts, ...preBreakouts].map((s) => quoteKey(s.exchange, s.symbol)))),
    [topBreakouts, preBreakouts],
  );
  const { data: scoreQuotes } = useQuotes(scoreKeys);
  const pushTicks = useLiveTickStore((s) => s.ticks);
  const liveByKey = useMemo(() => {
    const m = new Map((scoreQuotes?.quotes ?? []).map((q) => [quoteKey(q.exchange, q.symbol), q]));
    for (const [key, tick] of Object.entries(pushTicks)) {
      if (!isFreshTick(tick)) continue;
      const base = m.get(key);
      m.set(key, base ? { ...base, ltp: tick.ltp, change_pct: tick.change_pct } : ({ ltp: tick.ltp, change_pct: tick.change_pct } as any));
    }
    return m;
  }, [scoreQuotes, pushTicks]);
  const liveFor = (s: StockScore) => liveByKey.get(quoteKey(s.exchange, s.symbol));
  const anyPush = useMemo(() => scoreKeys.some((k) => isFreshTick(pushTicks[k])), [scoreKeys, pushTicks]);
  const liveQuoteState = useMemo<"push" | "live" | "stale" | "none">(() => {
    if (anyPush) return "push";
    const quotes = scoreQuotes?.quotes ?? [];
    if (quotes.length === 0) return "none";
    return quotes.some((q) => q.stale) ? "stale" : "live";
  }, [scoreQuotes, anyPush]);

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
    {
      header: "Price", id: "livePrice", meta: { align: "right" },
      accessorFn: (s) => liveFor(s)?.ltp ?? s.close,
      cell: ({ getValue }) => fmtNum(getValue()),
    },
    {
      header: "Chg %", id: "liveChangePct", meta: { align: "right" },
      accessorFn: (s) => liveFor(s)?.change_pct ?? s.change_pct,
      cell: ({ getValue }) => <PctCell value={getValue()} />,
    },
    { header: "RVol", accessorKey: "rel_volume", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue(), 1) },
    { header: "RSI", accessorKey: "rsi14", meta: { align: "right" }, cell: ({ getValue }) => fmtNum(getValue(), 0) },
    {
      header: "Breakout", accessorKey: "breakout_score", meta: { align: "right" },
      cell: ({ row }) => <ScoreBadge score={row.original.breakout_score} components={row.original.score_components?.breakout} label="breakout components" />,
    },
    {
      header: "Entry ≈", id: "entry", meta: { align: "right" },
      accessorFn: (r) => r.resistance_level ?? r.close,
      cell: ({ getValue }) => fmtNum(getValue()),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [liveByKey]);

  const filteredBreakouts = useMemo(
    () => topBreakouts.filter((s) => (s.breakout_score ?? 0) >= 60).slice(0, 12),
    [topBreakouts],
  );

  const ETF_RE = /(BEES|IETF|LIQUID|ETF|GOLD|SILVER)/i;
  const filteredPreBreakouts = useMemo(
    () => preBreakouts.filter((s) => {
      if ((s.prebreakout_score ?? 0) < 60) return false;
      if (ETF_RE.test(s.symbol)) return false;
      if (!s.sector) return false;
      const flags = [s.bb_squeeze, s.higher_lows, s.near_resistance].filter(Boolean).length;
      return flags >= 1;
    }).slice(0, 12),
    [preBreakouts],
  );

  const filteredSectors = useMemo(
    () => sectors.filter((s) => s.sector && s.sector.toLowerCase() !== "unknown").slice(0, 8),
    [sectors],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <HudPanel flow title="Market Summary" live={indicesFetching ? "warn" : "ok"} actions={
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {!connected && (
            <Link to="/market/settings" title="Using Yahoo Finance — connect Kotak Neo for live NSE" style={{ fontSize: 10, color: "var(--text-dim)", textDecoration: "none", padding: "2px 6px", border: "1px dashed var(--edge)", marginRight: 4 }}>
              yahoo · connect kotak
            </Link>
          )}
          <Btn size="sm" onClick={() => setManageOpen(true)} title="Manage indices"><Settings2 size={12} /></Btn>
          <Btn size="sm" onClick={primeData} disabled={busy !== null} title={busy === "prime" ? "priming…" : "prime data pipeline"}><Sparkles size={12} /></Btn>
          <Btn size="sm" onClick={() => refetchIndices()} disabled={indicesFetching} title="refresh"><RefreshCw size={12} /></Btn>
        </div>
      }>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 6 }}>
          {(indicesData?.quotes ?? []).map((q) => (
            <button
              key={q.symbol}
              onClick={() => nav(`/market/index/${encodeURIComponent(q.symbol)}`)}
              title={`${q.name} — view details`}
              style={{
                padding: "6px 8px", border: "1px solid var(--edge)", background: "transparent",
                textAlign: "left", cursor: "pointer", borderRadius: 2,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--edge-strong)"; e.currentTarget.style.background = "rgba(53,214,237,0.05)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--edge)"; e.currentTarget.style.background = "transparent"; }}
            >
              <div className="hud-label" style={{ color: "var(--text-dim)", fontSize: 9 }}>{q.name}</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
                <span style={{ fontFamily: "var(--font-display)", fontSize: 15, color: "var(--text)" }}>
                  {Number(q.price).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
                <span style={{ fontSize: 10, color: (q.change_pct ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }}>
                  {q.change_pct == null ? "—" : `${q.change_pct >= 0 ? "+" : ""}${q.change_pct.toFixed(2)}%`}
                </span>
              </div>
            </button>
          ))}
        </div>
      </HudPanel>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(260px, 1fr)", gap: 10, alignItems: "start" }}>
        <HudPanel
          flow
          title="Top Breakouts"
          actions={
            <span style={{ fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.1em", textTransform: "uppercase" }}>
              {liveQuoteState === "push" && <Chip tone="ok">push · relay live</Chip>}
              {liveQuoteState === "live" && <Chip tone="ok">price live</Chip>}
              {liveQuoteState === "stale" && <Chip tone="warn">quotes degraded — cached close</Chip>}
              {liveQuoteState === "none" && "price · yesterday's close"}
            </span>
          }
        >
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 6 }}>
            Score/RSI/RVol are end-of-day (recomputed once daily, same as standard technical scoring) — price & chg% update live.
          </div>
          <DataTable
            columns={breakoutColumns}
            data={filteredBreakouts}
            onRowClick={(r) => nav(`/market/analysis/${r.symbol}`)}
            initialSort={[{ id: "breakout_score", desc: true }]}
            emptyLabel="no breakouts ≥60"
            emptyHint="run the data pipeline from Settings, or wait for the evening cron"
          />
        </HudPanel>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <HudPanel flow title="Portfolio">
            {pf ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                <StatTile label="Value" value={`₹${Math.round(pf.current).toLocaleString("en-IN")}`} to="/market/holdings" />
                <StatTile label="Total P&L" value={`${pf.pnl >= 0 ? "+" : ""}₹${Math.round(pf.pnl).toLocaleString("en-IN")}`} tone={pf.pnl >= 0 ? "ok" : "err"} />
                {pf.day != null && (
                  <StatTile label="Today" value={`${pf.day >= 0 ? "+" : ""}₹${Math.round(pf.day).toLocaleString("en-IN")}`} tone={pf.day >= 0 ? "ok" : "err"} />
                )}
                <StatTile label={`${counts?.holdings ?? 0} held · ${counts?.watchlist ?? 0} watched`} value="" to="/market/holdings" />
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-dim)" }}>
                <Link to="/market/holdings" style={{ color: "var(--accent)", textDecoration: "none" }}>+ add holdings</Link>
                <Link to="/market/watchlist" style={{ color: "var(--accent)", textDecoration: "none" }}>+ watchlist</Link>
              </div>
            )}
          </HudPanel>

          <HudPanel flow title="Sector Strength">
            {filteredSectors.length === 0 ? (
              <div className="hud-label" style={{ color: "var(--text-dim)" }}>pipeline pending</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {filteredSectors.map((s) => (
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
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(260px, 1fr)", gap: 10, alignItems: "start" }}>
        <HudPanel flow title="Pre-Breakout Watch">
          {filteredPreBreakouts.length === 0 ? (
            <div className="hud-label" style={{ color: "var(--text-dim)" }}>no coiled setups yet</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 4 }}>
              {filteredPreBreakouts.map((s) => (
                <div key={s.id} onClick={() => nav(`/market/analysis/${s.symbol}`)}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 6px", border: "1px solid var(--edge)", cursor: "pointer", fontSize: 12 }}>
                  <span>
                    <span style={{ color: "var(--accent)" }}>{s.symbol}</span>
                    <span style={{ display: "inline-flex", gap: 3, marginLeft: 6 }}>
                      {s.bb_squeeze && <Chip tone="accent">sq</Chip>}
                      {s.higher_lows && <Chip tone="ok">HL</Chip>}
                      {s.near_resistance && <Chip tone="warn">@r</Chip>}
                    </span>
                  </span>
                  <ScoreBadge score={s.prebreakout_score} components={s.score_components?.prebreakout} label="pre-breakout components" />
                </div>
              ))}
            </div>
          )}
        </HudPanel>

        <HudPanel flow title="AI Insight" actions={
          <Btn size="sm" onClick={loadInsight} disabled={busy !== null}>
            <Sparkles size={11} style={{ marginRight: 4 }} /> {busy === "insight" ? "…" : "generate"}
          </Btn>
        }>
          {insight
            ? <div style={{ fontSize: 12, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{insight}</div>
            : <div className="hud-label" style={{ color: "var(--text-dim)", fontSize: 10 }}>tap generate for today's brief</div>}
        </HudPanel>
      </div>

      {manageOpen && <ManageIndicesDialog onClose={() => setManageOpen(false)} />}
    </div>
  );
}

function ManageIndicesDialog({ onClose }: { onClose: () => void }) {
  const { data: rows = [] } = useIndexWatch();
  const { add, remove } = useIndexWatchMutations();
  const [tab, setTab] = useState<"IN" | "GLOBAL" | "custom">("IN");
  const [customSym, setCustomSym] = useState("");
  const [customName, setCustomName] = useState("");
  const existing = new Set(rows.map((r) => r.symbol));

  const addPreset = (p: IndexPreset) => add.mutate({
    symbol: p.symbol, name: p.name, region: p.region,
    nse_symbol: p.nse_symbol ?? null,
    fno_enabled: !!p.fno_enabled,
    constituents_slug: p.constituents_slug ?? null,
  });

  const addCustom = () => {
    const sym = customSym.trim();
    const nm = customName.trim() || sym;
    if (!sym) return;
    add.mutate({ symbol: sym, name: nm, region: "GLOBAL", nse_symbol: null, fno_enabled: false, constituents_slug: null });
    setCustomSym(""); setCustomName("");
  };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "min(720px, 96vw)", maxHeight: "90vh", overflowY: "auto",
        background: "var(--bg)", border: "1px solid var(--edge-strong)",
        padding: 16, display: "flex", flexDirection: "column", gap: 12,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="hud-label" style={{ color: "var(--accent)", letterSpacing: "0.2em" }}>Manage indices</div>
          <button onClick={onClose} className="hud-btn focus-outline" data-variant="ghost" data-size="sm" title="Close"><X size={14} /></button>
        </div>

        <div>
          <div className="hud-label" style={{ color: "var(--text-dim)", marginBottom: 6 }}>Current ({rows.length})</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 200, overflow: "auto", border: "1px solid var(--edge)" }}>
            {rows.map((r) => (
              <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", borderBottom: "1px solid var(--edge)", fontSize: 12 }}>
                <span>
                  <span style={{ color: "var(--accent)" }}>{r.name}</span>
                  <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 10 }}>{r.symbol} · {r.region}</span>
                </span>
                <button onClick={() => remove.mutate(r.id)} className="hud-btn focus-outline" data-variant="ghost" data-size="sm" title="Remove">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {rows.length === 0 && <div style={{ padding: 10, color: "var(--text-dim)", fontSize: 12 }}>none yet</div>}
          </div>
        </div>

        <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--edge)" }}>
          {(["IN", "GLOBAL", "custom"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              style={{
                padding: "6px 10px", background: "transparent", border: 0,
                borderBottom: `2px solid ${tab === t ? "var(--accent)" : "transparent"}`,
                color: tab === t ? "var(--accent)" : "var(--text-dim)",
                fontSize: 11, letterSpacing: "0.15em", textTransform: "uppercase", cursor: "pointer",
              }}>{t === "IN" ? "Indian" : t === "GLOBAL" ? "Global" : "Custom"}</button>
          ))}
        </div>

        {tab !== "custom" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 6 }}>
            {(tab === "IN" ? INDIAN_PRESETS : GLOBAL_PRESETS).map((p) => {
              const has = existing.has(p.symbol);
              return (
                <button key={p.symbol} disabled={has || add.isPending}
                  onClick={() => addPreset(p)}
                  style={{
                    padding: 8, border: "1px solid var(--edge)", background: has ? "rgba(53,214,237,0.08)" : "transparent",
                    textAlign: "left", cursor: has ? "default" : "pointer", opacity: has ? 0.7 : 1, borderRadius: 2,
                  }}>
                  <div style={{ color: has ? "var(--text-dim)" : "var(--accent)", fontSize: 12 }}>{p.name}</div>
                  <div style={{ color: "var(--text-muted)", fontSize: 10 }}>{p.symbol}{has ? " · added" : ""}</div>
                </button>
              );
            })}
          </div>
        )}

        {tab === "custom" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Add any Yahoo Finance symbol (e.g. ^GSPC, ^N225, NIFTY_MIDCAP_50.NS)</div>
            <input value={customSym} onChange={(e) => setCustomSym(e.target.value)} placeholder="Yahoo symbol"
              style={{ padding: 8, background: "transparent", border: "1px solid var(--edge)", color: "var(--text)", fontFamily: "var(--font-mono)" }} />
            <input value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="Display name (optional)"
              style={{ padding: 8, background: "transparent", border: "1px solid var(--edge)", color: "var(--text)" }} />
            <Btn size="sm" onClick={addCustom} disabled={!customSym.trim() || add.isPending}>add</Btn>
          </div>
        )}
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
