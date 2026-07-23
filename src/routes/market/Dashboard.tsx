// Market Dashboard — "what are the best stocks to buy today?"
// Indices + real breadth, sector strength, top breakout stocks, pre-breakout watch,
// watchlist pulse, AI daily insight.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { DataTable, fmtNum, PctCell } from "@/components/hud/DataTable";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { WatchlistPanel } from "@/components/market/WatchlistPanel";
import { supabase } from "@/integrations/supabase/client";
import { callMarketFn } from "@/lib/market/api";
import { useIndices, useIndexWatch, useIndexWatchMutations, useMarketSettings, usePositions, useQuotes, useSavedScreeners, useStockScores } from "@/lib/market/hooks";
import { useBrokerOrders } from "@/lib/market/orderHooks";
import { FILTER_BY_ID, canonicalFilterId, filterMatches, latestTradeDateOf, type ActiveFilter, type UniverseId } from "@/lib/market/screenerCatalog";
import { useScreenerData, type ScreenerRow } from "@/lib/market/screenerRun";
import { ALL_PRESETS, GLOBAL_PRESETS, INDIAN_PRESETS, type IndexPreset } from "@/lib/market/indices";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { RefreshCw, Settings2, Sparkles, Trash2, X } from "lucide-react";
import type { Quote, StockScore } from "@/lib/market/types";
import { holdingPnl, quoteKey, sumNullable } from "@/lib/market/pnl";
import { isFreshTick, useLiveTickStore } from "@/lib/market/liveTickStore";
import { useEscapeClose } from "@/lib/useEscapeClose";
import { MarketStrip } from "@/components/market/MarketStrip";


const BREAKOUT_ROWS = 16;

// IST market hours check (Mon–Fri 09:15–15:30). Used to differentiate
// "cached close" (intraday stale data — actionable) from "closed" (after
// hours — expected). Uses Intl to avoid TZ drift on non-IST clients.
function isNseOpen(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = get("weekday");
  if (day === "Sat" || day === "Sun") return false;
  const hh = Number(get("hour")); const mm = Number(get("minute"));
  const mins = hh * 60 + mm;
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

const DEFAULT_BREAKOUT_KEY = "market.dash.breakoutScreen";
const EXPLICIT_CLEAR = "__cleared__";

type BreakoutDisplayRow = StockScore | ScreenerRow;

const UNIVERSE_IDS: UniverseId[] = ["all", "nifty500", "nifty50", "banknifty", "finnifty"];

function isUniverseId(value: unknown): value is UniverseId {
  return typeof value === "string" && UNIVERSE_IDS.includes(value as UniverseId);
}

function savedScreenerState(screen: { filters?: unknown } | undefined): { active: ActiveFilter[]; universe: UniverseId } {
  const raw = screen?.filters;
  if (!raw || Array.isArray(raw) || typeof raw !== "object") return { active: [], universe: "all" };
  const payload = raw as { active?: unknown; universe?: unknown };
  return {
    active: Array.isArray(payload.active) ? payload.active as ActiveFilter[] : [],
    universe: isUniverseId(payload.universe) ? payload.universe : "all",
  };
}

function rowKey(row: BreakoutDisplayRow): string {
  return quoteKey(row.exchange ?? "NSE", row.symbol);
}

function rowPrice(row: BreakoutDisplayRow): number | null {
  const r = row as any;
  return r.ltp ?? r.close ?? null;
}


function byBreakoutDesc(a: BreakoutDisplayRow, b: BreakoutDisplayRow): number {
  return ((b.breakout_score ?? -1) - (a.breakout_score ?? -1)) || a.symbol.localeCompare(b.symbol);
}

export default function MarketDashboard() {
  const push = useUi((s) => s.push);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [breakoutScreenId, setBreakoutScreenId] = useState<string>(
    () => {
      const v = localStorage.getItem(DEFAULT_BREAKOUT_KEY);
      if (v === EXPLICIT_CLEAR) return "";
      return v && v !== "default" ? v : "";
    },
  );
  useEffect(() => {
    if (breakoutScreenId) localStorage.setItem(DEFAULT_BREAKOUT_KEY, breakoutScreenId);
  }, [breakoutScreenId]);
  const { data: savedScreens = [] } = useSavedScreeners();
  // If nothing is chosen yet, fall back to the first saved screener.
  // Distinguish "never chosen" (empty stored value) from "explicitly cleared"
  // (EXPLICIT_CLEAR marker) — the latter must not auto-jump. If the current
  // id no longer exists (screener deleted elsewhere), clear the stored key
  // rather than silently switch to another screener.
  useEffect(() => {
    if (savedScreens.length === 0) return;
    if (breakoutScreenId) {
      const stillValid = savedScreens.some((s) => s.id === breakoutScreenId);
      if (!stillValid) {
        try { localStorage.removeItem(DEFAULT_BREAKOUT_KEY); } catch { /* noop */ }
        setBreakoutScreenId("");
      }
      return;
    }
    const stored = (() => { try { return localStorage.getItem(DEFAULT_BREAKOUT_KEY); } catch { return null; } })();
    if (stored === EXPLICIT_CLEAR) return; // user asked for "no filter"
    setBreakoutScreenId(savedScreens[0].id);
  }, [savedScreens, breakoutScreenId]);
  const selectedScreen = savedScreens.find((s) => s.id === breakoutScreenId);
  const selectedScreenState = useMemo(() => savedScreenerState(selectedScreen), [selectedScreen]);

  useEffect(() => {
    const handler = () => qc.invalidateQueries({ queryKey: ["market"] });
    window.addEventListener("market:refresh", handler);
    return () => window.removeEventListener("market:refresh", handler);
  }, [qc]);


  const { data: indicesData, refetch: refetchIndices, isFetching: indicesFetching } = useIndices();
  const { data: settings = [] } = useMarketSettings();
  // Fetched pool is wider than what's shown (12) so the filter bar below has
  // something to narrow beyond the top-15-by-score slice.
  const { data: topBreakouts = [] } = useStockScores({ orderBy: "breakout_score", limit: 60 });
  const { data: preBreakouts = [] } = useStockScores({ orderBy: "prebreakout_score", limit: 10 });
  const usingSavedScreen = Boolean(selectedScreen);
  const { data: savedScreenerRows = [], isFetching: savedScreenerFetching } = useScreenerData(selectedScreenState.universe, usingSavedScreen);

  const hasActiveFilters = selectedScreenState.active.length > 0;
  const matchingBreakouts = useMemo<BreakoutDisplayRow[]>(() => {
    if (!usingSavedScreen || !hasActiveFilters) return [];
    const active = selectedScreenState.active;
    const latestDate = latestTradeDateOf(savedScreenerRows);
    const source = savedScreenerRows.filter((s) => active.every((af) => filterMatches(s as any, af, latestDate)));
    return [...source].sort(byBreakoutDesc);
  }, [savedScreenerRows, selectedScreenState.active, usingSavedScreen, hasActiveFilters]);

  const filteredBreakouts = useMemo(() => matchingBreakouts.slice(0, BREAKOUT_ROWS), [matchingBreakouts]);

  // One chip only — the screener name is already visible in the <select>.
  // Show the count when a screener with filters is active, otherwise a
  // minimal hint about what's needed.
  const breakoutCountLabel = !usingSavedScreen
    ? (savedScreens.length === 0 ? "no screeners saved" : "select a screener")
    : !hasActiveFilters
    ? "screener has no filters"
    : (savedScreenerFetching ? "loading…" : `${matchingBreakouts.length} matches`);



  // The scores above are EOD (recomputed once a day by the evening pipeline —
  // RSI/EMA/breakout scoring is inherently a daily-bar concept, same as any
  // trading platform). But the displayed price/change% shouldn't sit frozen at
  // yesterday's close all session — overlay live quotes on top of them.
  // Union key set for on-screen scored rows. Memoize by joined string so
  // toggling filters that don't add new symbols doesn't refire useQuotes.
  const scoreKeysJoined = useMemo(
    () => Array.from(new Set([...topBreakouts, ...preBreakouts, ...filteredBreakouts].map(rowKey))).sort().join(","),
    [topBreakouts, preBreakouts, filteredBreakouts],
  );
  const scoreKeys = useMemo(() => (scoreKeysJoined ? scoreKeysJoined.split(",") : []), [scoreKeysJoined]);
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
  const liveFor = (s: BreakoutDisplayRow) => liveByKey.get(rowKey(s));
  const anyPush = useMemo(() => scoreKeys.some((k) => isFreshTick(pushTicks[k])), [scoreKeys, pushTicks]);
  const liveQuoteState = useMemo<"push" | "live" | "stale" | "closed" | "none">(() => {
    if (anyPush) return "push";
    const quotes = scoreQuotes?.quotes ?? [];
    if (quotes.length === 0) return "none";
    const hasStale = quotes.some((q) => q.stale);
    if (!hasStale) return "live";
    // Stale outside market hours = expected end-of-day snapshot, not a problem.
    return isNseOpen() ? "stale" : "closed";
  }, [scoreQuotes, anyPush, scoreKeys]);

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
    // Rows with no resolvable live price are excluded from current/pnl
    // (unknown, not zero) — see holdingPnl's contract in lib/market/pnl.ts.
    // Today % must use the SAME resolved-symbol set for numerator (day P&L)
    // and denominator (prev value), otherwise the ratio is nonsense when even
    // one symbol lacks a previous_close.
    let invested = 0, current = 0, knownInvested = 0, unresolved = 0;
    let dayPnlWithPrev = 0;   // day P&L only for rows that also have prev_close
    let prevValue = 0;
    let prevValueKnown = false;
    const dayPnlsAll: Array<number | null> = [];
    for (const h of rows) {
      const q = byKey.get(quoteKey(h.exchange, h.symbol));
      const calc = holdingPnl({ quantity: h.quantity, avgPrice: h.avg_price, quote: q });
      invested += calc.invested;
      if (calc.current == null) { unresolved++; continue; }
      knownInvested += calc.invested;
      current += calc.current;
      dayPnlsAll.push(calc.todayPnl);
      if (q?.previous_close != null && q.previous_close > 0) {
        prevValue += q.previous_close * h.quantity;
        prevValueKnown = true;
        if (calc.todayPnl != null) dayPnlWithPrev += calc.todayPnl;
      }
    }
    const day = sumNullable(dayPnlsAll);
    const dayPct = prevValueKnown && prevValue !== 0 ? (dayPnlWithPrev / prevValue) * 100 : null;
    const allUnresolved = unresolved === rows.length;
    return {
      invested: allUnresolved ? null : invested,
      current: allUnresolved ? null : current,
      pnl: allUnresolved ? null : current - knownInvested,
      day: allUnresolved ? null : day,
      dayPct,
    };
  }, [counts, pfQuotes]);

  // Positions summary
  const { data: positions = [] } = usePositions();
  const openPositions = useMemo(() => positions.filter((p) => !p.closed_at), [positions]);
  const posKeys = useMemo(() => Array.from(new Set(openPositions.map((p) => `${p.exchange}:${p.symbol}`))), [openPositions]);
  const { data: posQuotes } = useQuotes(posKeys);
  const posSummary = useMemo(() => {
    const byKey = new Map((posQuotes?.quotes ?? []).map((q) => [quoteKey(q.exchange, q.symbol), q]));
    let exposure = 0, unrealized = 0, resolved = 0;
    for (const p of openPositions) {
      const q = byKey.get(quoteKey(p.exchange, p.symbol));
      const ltp = q?.ltp;
      if (ltp == null) continue;
      resolved++;
      const sign = p.side === "long" ? 1 : -1;
      exposure += ltp * p.quantity;
      unrealized += sign * (ltp - p.entry_price) * p.quantity;
    }
    return { count: openPositions.length, exposure, unrealized: resolved === 0 ? null : unrealized };
  }, [openPositions, posQuotes]);

  // Broker orders summary
  const { data: brokerOrdersData } = useBrokerOrders();
  const orderSummary = useMemo(() => {
    const orders = brokerOrdersData?.orders ?? [];
    const open = orders.filter((o) => /open|pending|trigger/i.test(o.status)).length;
    const executed = orders.filter((o) => /complete|executed|filled/i.test(o.status)).length;
    const rejected = orders.filter((o) => /reject|cancel|fail/i.test(o.status)).length;
    return { total: orders.length, open, executed, rejected };
  }, [brokerOrdersData]);




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

  // Row 1 index panels were removed (duplicated MarketStrip). Region/tile helpers dropped.


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


  const breakoutColumns = useMemo<ColumnDef<BreakoutDisplayRow, any>[]>(() => {
    const symbolCol: ColumnDef<BreakoutDisplayRow, any> = {
      header: "Symbol", accessorKey: "symbol",
      cell: ({ row }) => (
        <span>
          <span style={{ color: "var(--accent)" }}>{row.original.symbol}</span>
          {row.original.sector && <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 10 }}>{row.original.sector}</span>}
        </span>
      ),
    };
    const breakoutCol: ColumnDef<BreakoutDisplayRow, any> = {
      header: "Breakout", accessorKey: "breakout_score", meta: { align: "right" },
      cell: ({ row }) => <ScoreBadge score={row.original.breakout_score} components={row.original.score_components?.breakout} label="breakout components" />,
    };

    const pctIds = new Set(["change_pct", "ret_5d", "ret_21d", "ret_ytd", "dividend_yield", "sales_growth", "profit_growth", "eps_growth", "roe", "roce", "promoter_holding", "dii_holding", "fii_holding", "institutional_holding", "pct_from_52w_high", "atr_pct", "rel_strength_nifty"]);

    const seen = new Set<string>([ "symbol", "breakout_score" ]);
    const filterCols: ColumnDef<BreakoutDisplayRow, any>[] = [];
    for (const af of selectedScreenState.active) {
      const id = canonicalFilterId(af.id);
      if (seen.has(id)) continue;
      const def = FILTER_BY_ID[id];
      if (!def) continue;
      seen.add(id);

      const accessor = (s: BreakoutDisplayRow): any => {
        const r = s as any;
        if (id === "ltp") return liveFor(s)?.ltp ?? r.ltp ?? r.close ?? null;
        if (id === "change_pct") return liveFor(s)?.change_pct ?? r.change_pct_raw ?? r.change_pct ?? null;
        if (def.valueKey) return r[def.valueKey] ?? r[id] ?? null;
        return r[id] ?? null;
      };

      const unit = def.unit;
      const renderNumber = (v: any) => {
        if (v == null || v === "" || Number.isNaN(Number(v))) return "—";
        const n = Number(v);
        const formatted = fmtNum(n);
        if (!unit) return formatted;
        if (unit === "₹") return `₹${formatted}`;
        if (unit === "%") return `${formatted}%`;
        return `${formatted} ${unit}`;
      };

      const col: ColumnDef<BreakoutDisplayRow, any> = {
        id: `flt_${id}`,
        header: def.label,
        accessorFn: accessor,
        meta: { align: def.kind === "enum" ? "left" : "right" },
        cell: ({ getValue }) => {
          const v = getValue();
          if (def.kind === "boolean") return v ? "Yes" : v === false || v == null ? "No" : "—";
          if (def.kind === "enum") return v ?? "—";
          if (pctIds.has(id)) return <PctCell value={v as any} />;
          return renderNumber(v);
        },
      };
      filterCols.push(col);
    }

    return [symbolCol, ...filterCols, breakoutCol];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveByKey, selectedScreenState.active]);




  const runPrimeData = () => {
    if (busy) return;
    // Use the app's toast layer to warn instead of a blocking window.confirm.
    // First click arms it, second click within 5s runs the pipeline.
    if (busy === null && !window.sessionStorage.getItem("mk.prime.armed")) {
      window.sessionStorage.setItem("mk.prime.armed", "1");
      setTimeout(() => window.sessionStorage.removeItem("mk.prime.armed"), 5_000);
      push("Prime runs 4 edge functions (~1 min). Click again to confirm.", "warn");
      return;
    }
    window.sessionStorage.removeItem("mk.prime.armed");
    primeData();
  };

  const providerLabel = connected ?? "yahoo";
  const indexActions = (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      {!connected && (
        <Link to="/market/settings" title="Using Yahoo Finance — connect a broker for live NSE quotes"
              style={{ fontSize: 10, color: "var(--text-dim)", textDecoration: "none", padding: "2px 6px", border: "1px dashed var(--edge)", marginRight: 4 }}>
          {providerLabel} · connect broker
        </Link>
      )}
      <Btn size="sm" onClick={() => setManageOpen(true)} title="Manage indices" ariaLabel="Manage indices"><Settings2 size={12} /></Btn>
      <Btn size="sm" variant="danger" onClick={runPrimeData} disabled={busy !== null} title={busy === "prime" ? "priming…" : "prime data pipeline (scrips → EOD → aggregates → indices)"} ariaLabel="Prime data pipeline"><Sparkles size={12} /></Btn>
      <Btn size="sm" onClick={() => refetchIndices()} disabled={indicesFetching} title="Refresh indices" ariaLabel="Refresh indices"><RefreshCw size={12} /></Btn>
    </div>
  );

  const indicesLive = indicesData ? "ok" : (indicesFetching ? "warn" : "err");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0, height: "100%" }}>
      <MarketStrip />
      {/* Compact toolbar — index/pipeline actions live here (was two duplicate index panels) */}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6, flexShrink: 0 }}>
        {!connected && (
          <Link to="/market/settings" title="Using Yahoo Finance — connect a broker for live NSE quotes"
                style={{ fontSize: 10, color: "var(--text-dim)", textDecoration: "none", padding: "2px 6px", border: "1px dashed var(--edge)" }}>
            {providerLabel} · connect broker
          </Link>
        )}
        <Chip tone={indicesLive === "ok" ? "ok" : indicesLive === "warn" ? "warn" : "neutral"}>
          {indicesLive === "ok" ? "indices live" : indicesLive === "warn" ? "loading…" : "no data"}
        </Chip>
        {indexActions}
      </div>

      {/* Row 2 · Top Breakouts · Watchlist · Portfolio (right) */}
      <div
        className="mk-dash-row2"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 2.4fr) minmax(0, 1.6fr) minmax(0, 1.1fr)",
          gap: 8,
          alignItems: "stretch",
          flex: 1,
          minHeight: 0,
          gridAutoRows: "1fr",
        }}
      >

      <HudPanel
        flow
        title="Top Breakouts"
        actions={
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <select
              value={breakoutScreenId}
              onChange={(e) => setBreakoutScreenId(e.target.value)}
              title="Filter Top Breakouts using a saved screener"
              style={{
                fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase",
                background: "transparent", color: "var(--text)", border: "1px solid var(--edge)",
                padding: "3px 6px", cursor: "pointer",
              }}
            >
              {savedScreens.length === 0 && <option value="">No saved screeners</option>}
              {savedScreens.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <Chip tone={savedScreenerFetching ? "warn" : "neutral"}>{breakoutCountLabel}</Chip>
            {liveQuoteState === "push" && <Chip tone="ok">push · live</Chip>}
            {liveQuoteState === "live" && <Chip tone="ok">live</Chip>}
            {liveQuoteState === "stale" && <Chip tone="warn">cached close</Chip>}
            {liveQuoteState === "closed" && <Chip tone="neutral">market closed</Chip>}
          </div>
        }
      >
        <DataTable
          columns={breakoutColumns}
          data={filteredBreakouts}
          onRowClick={(r) => nav(`/market/analysis/${r.symbol}`)}
          initialSort={[{ id: "breakout_score", desc: true }]}
          maxHeight="100%"
          emptyLabel={savedScreenerFetching ? "loading" : !usingSavedScreen ? "select a screener" : !hasActiveFilters ? "add filters to your screener" : "no matches"}
        />
      </HudPanel>
        <WatchlistPanel
          readyCount={watchPulse.ready}
          nearCount={watchPulse.near}
          weakCount={watchPulse.weak}
          onSettings={() => nav("/market/settings")}
        />
        <HudPanel flow title="Portfolio">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {/* Holdings */}
            <PortfolioSection
              label="Holdings"
              to="/market/holdings"
              meta={counts?.holdings ? `${counts.holdings} ${counts.holdings === 1 ? "stock" : "stocks"}` : ""}
              tiles={pf ? [
                { label: "Value", value: pf.current == null ? "—" : `₹${Math.round(pf.current).toLocaleString("en-IN")}` },
                { label: "Total P&L", value: pf.pnl == null ? "—" : `${pf.pnl >= 0 ? "+" : ""}₹${Math.round(pf.pnl).toLocaleString("en-IN")}`, tone: pf.pnl == null ? undefined : pf.pnl >= 0 ? "ok" : "err" },
                { label: "Today", value: pf.day == null ? "—" : `${pf.day >= 0 ? "+" : ""}₹${Math.round(pf.day).toLocaleString("en-IN")}${pf.dayPct != null ? ` (${pf.dayPct >= 0 ? "+" : ""}${pf.dayPct.toFixed(2)}%)` : ""}`, tone: pf.day == null ? undefined : pf.day >= 0 ? "ok" : "err" },
              ] : []}
              empty="No holdings yet"
            />
            {/* Positions */}
            <PortfolioSection
              label="Positions"
              to="/market/positions"
              meta={posSummary.count > 0 ? `${posSummary.count} open` : ""}
              tiles={posSummary.count > 0 ? [
                { label: "Exposure", value: `₹${Math.round(posSummary.exposure).toLocaleString("en-IN")}` },
                { label: "Unrealized", value: posSummary.unrealized == null ? "—" : `${posSummary.unrealized >= 0 ? "+" : ""}₹${Math.round(posSummary.unrealized).toLocaleString("en-IN")}`, tone: posSummary.unrealized == null ? undefined : posSummary.unrealized >= 0 ? "ok" : "err" },
              ] : []}
              empty="No open positions"
            />
            {/* Orders */}
            <PortfolioSection
              label="Orders"
              to="/market/orders"
              meta={orderSummary.total > 0 ? `${orderSummary.total} today` : ""}
              tiles={orderSummary.total > 0 ? [
                { label: "Open", value: String(orderSummary.open), tone: orderSummary.open > 0 ? "accent" : undefined },
                { label: "Executed", value: String(orderSummary.executed), tone: orderSummary.executed > 0 ? "ok" : undefined },
                { label: "Rejected", value: String(orderSummary.rejected), tone: orderSummary.rejected > 0 ? "err" : undefined },
              ] : []}
              empty="No orders today"
            />
          </div>
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
  useEscapeClose(true, onClose);

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
    if (!/^[\^A-Z0-9._=-]+$/.test(sym)) {
      // eslint-disable-next-line no-alert
      alert("Invalid Yahoo symbol. Use uppercase letters, digits and any of ^ . _ = - (e.g. ^GSPC, NIFTY_MIDCAP_50.NS)");
      return;
    }
    add.mutate({ symbol: sym, name: nm, region: "GLOBAL", nse_symbol: null, fno_enabled: false, constituents_slug: null });
    setCustomSym(""); setCustomName("");
  };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="manage-indices-title"
        style={{
          width: "min(720px, 96vw)", maxHeight: "90vh", overflowY: "auto",
          background: "var(--bg)", border: "1px solid var(--edge-strong)",
          padding: 16, display: "flex", flexDirection: "column", gap: 12,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div id="manage-indices-title" className="hud-label" style={{ color: "var(--accent)", letterSpacing: "0.2em" }}>Manage indices</div>
          <button onClick={onClose} className="hud-btn focus-outline" data-variant="ghost" data-size="sm" title="Close" aria-label="Close manage indices"><X size={14} /></button>
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

type Tile = { label: string; value: string; tone?: "ok" | "err" | "accent" };
function PortfolioSection({
  label, to, meta, tiles, empty,
}: { label: string; to: string; meta: string; tiles: Tile[]; empty: string }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span className="hud-label" style={{ color: "var(--text-dim)", fontSize: 10 }}>
          {label}
          {meta ? <span style={{ color: "var(--text-muted)" }}> · {meta}</span> : null}
        </span>
        <Link to={to} style={{ color: "var(--accent)", textDecoration: "none", fontSize: 10 }}>view →</Link>
      </div>
      {tiles.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "6px 2px" }}>{empty}</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${tiles.length}, 1fr)`, gap: 4 }}>
          {tiles.map((t) => {
            const color = t.tone === "ok" ? "var(--ok)" : t.tone === "err" ? "var(--danger)" : t.tone === "accent" ? "var(--accent)" : "var(--text)";
            return (
              <div key={t.label} style={{ padding: "6px 8px", border: "1px solid var(--edge)", borderRadius: 2 }}>
                <div className="hud-label" style={{ color: "var(--text-dim)", fontSize: 9 }}>{t.label}</div>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 15, color, fontVariantNumeric: "tabular-nums" }}>{t.value}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
