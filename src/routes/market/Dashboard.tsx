// Market Dashboard — "what are the best stocks to buy today?"
// Indices + real breadth, sector strength, top breakout stocks, pre-breakout watch,
// watchlist pulse, AI daily insight.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ColumnDef } from "@tanstack/react-table";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip } from "@/components/hud/HudControls";
import { DataTable, deriveChangeAbs, fmtNum, PctCell } from "@/components/hud/DataTable";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { WatchlistPanel } from "@/components/market/WatchlistPanel";
import { supabase } from "@/integrations/supabase/client";
import { callMarketFn } from "@/lib/market/api";
import { useIndices, useIndexWatch, useIndexWatchMutations, useMarketSettings, usePositions, useQuotes, useSavedScreeners, useStockScores } from "@/lib/market/hooks";
import { useBrokerOrders } from "@/lib/market/orderHooks";
import { FILTER_BY_ID, canonicalFilterId, filterMatches, latestTradeDateOf, type ActiveFilter, type UniverseId } from "@/lib/market/screenerCatalog";
import { useScreenerData, type ScreenerRow } from "@/lib/market/screenerRun";
import { colsFromActiveFilters, overviewColumnMap, OVERVIEW_COL_IDS } from "@/lib/market/screenerColumns";
import { ALL_PRESETS, GLOBAL_PRESETS, INDIAN_PRESETS, type IndexPreset } from "@/lib/market/indices";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { Trash2, X } from "lucide-react";
import type { Quote, StockScore } from "@/lib/market/types";
import { holdingPnl, quoteKey } from "@/lib/market/pnl";
import { isFreshTick, nseOpenNow, useLiveTickStore, useTicksRevision} from "@/lib/market/liveTickStore";
import { subscribeSymbolsForTicks, useRelayAlive } from "@/lib/market/useRealtimeTicks";
import { useEscapeClose } from "@/lib/useEscapeClose";
import { MarketStrip } from "@/components/market/MarketStrip";
import { PriceSourceChip } from "@/components/market/PriceSourceChip";


const DEFAULT_BREAKOUT_KEY = "market.dash.breakoutScreen";
const SCREENER_DEFAULT_SAVED_KEY = "market.screener.defaultSavedId";
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
  const seen = new Set<string>();
  const active = Array.isArray(payload.active)
    ? payload.active.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const filter = item as ActiveFilter;
      const id = canonicalFilterId(filter.id);
      if (!FILTER_BY_ID[id] || seen.has(id)) return [];
      seen.add(id);
      return [{ ...filter, id }];
    })
    : [];
  return {
    active,
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

function bySavedScreenerDefault(active: ActiveFilter[]): (a: BreakoutDisplayRow, b: BreakoutDisplayRow) => number {
  const hasChangeFilter = active.some((filter) => canonicalFilterId(filter.id) === "change_pct");
  if (!hasChangeFilter) return byBreakoutDesc;
  return (a, b) => {
    const av = (a as any).change_pct;
    const bv = (b as any).change_pct;
    if (av == null && bv == null) return byBreakoutDesc(a, b);
    if (av == null) return 1;
    if (bv == null) return -1;
    return (Number(bv) - Number(av)) || byBreakoutDesc(a, b);
  };
}

export default function MarketDashboard() {
  const push = useUi((s) => s.push);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [, setBusy] = useState<string | null>(null);
  void setBusy;
  const [manageOpen, setManageOpen] = useState(false);
  const [breakoutScreenId, setBreakoutScreenId] = useState<string>(
    () => {
      const v = localStorage.getItem(DEFAULT_BREAKOUT_KEY);
      if (v === EXPLICIT_CLEAR) return "";
      if (v && v !== "default") return v;
      const screenerDefault = localStorage.getItem(SCREENER_DEFAULT_SAVED_KEY);
      return screenerDefault && screenerDefault !== "default" ? screenerDefault : "";
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
    const screenerDefault = (() => { try { return localStorage.getItem(SCREENER_DEFAULT_SAVED_KEY); } catch { return null; } })();
    const preferred = screenerDefault && savedScreens.some((s) => s.id === screenerDefault)
      ? screenerDefault
      : savedScreens[0].id;
    setBreakoutScreenId(preferred);
  }, [savedScreens, breakoutScreenId]);
  const selectedScreen = savedScreens.find((s) => s.id === breakoutScreenId);
  const selectedScreenState = useMemo(() => savedScreenerState(selectedScreen), [selectedScreen]);

  useEffect(() => {
    const handler = () => qc.invalidateQueries({ queryKey: ["market"] });
    window.addEventListener("market:refresh", handler);
    return () => window.removeEventListener("market:refresh", handler);
  }, [qc]);


  const { data: indicesData } = useIndices();
  const { data: settings = [] } = useMarketSettings();
  // Fetched pool is wider than what's shown (12) so the filter bar below has
  // something to narrow beyond the top-15-by-score slice.
  const { data: topBreakouts = [] } = useStockScores({ orderBy: "breakout_score", limit: 60 });
  const { data: preBreakouts = [] } = useStockScores({ orderBy: "prebreakout_score", limit: 10 });
  const usingSavedScreen = Boolean(selectedScreen);
  const { data: savedScreenerRows = [], isFetching: savedScreenerFetching } = useScreenerData(selectedScreenState.universe, null, usingSavedScreen);

  const hasActiveFilters = selectedScreenState.active.length > 0;
  const matchingBreakouts = useMemo<BreakoutDisplayRow[]>(() => {
    if (!usingSavedScreen || !hasActiveFilters) return [];
    const active = selectedScreenState.active;
    const latestDate = latestTradeDateOf(savedScreenerRows);
    const source = savedScreenerRows.filter((s) => active.every((af) => filterMatches(s as any, af, latestDate)));
    // Always sort Top Breakouts high → low by breakout score, regardless of
    // which filters are active. (Previously a change-based filter silently
    // switched the default sort to 1D Return.)
    void bySavedScreenerDefault;
    return [...source].sort(byBreakoutDesc);
  }, [savedScreenerRows, selectedScreenState.active, usingSavedScreen, hasActiveFilters]);

  const filteredBreakouts = matchingBreakouts;

  // One chip only — the screener name is already visible in the <select>.
  // Show the count when a screener with filters is active, otherwise a
  // minimal hint about what's needed.
  const breakoutCountLabel = !usingSavedScreen
    ? (savedScreens.length === 0 ? "no screeners saved" : "select a screener")
    : !hasActiveFilters
    ? "screener has no filters"
    : savedScreenerFetching
    ? "loading…"
    : `${matchingBreakouts.length} of ${savedScreenerRows.length}`;



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
  // Top Breakouts symbols rotate with filter selection, so most of them are
  // outside the Kotak WS relay's holdings/watchlist subscription set. Poll
  // the Kotak-primary REST batch every second during market hours to match
  // trading-app quote cadence.
  const { data: scoreQuotes, isError: scoreQuotesError } = useQuotes(scoreKeys, { intervalMs: 1_000 });
  const _ticksRev_pushTicks = useTicksRevision();
  const pushTicks = useLiveTickStore.getState().ticks;
  void _ticksRev_pushTicks; // re-render on any tick flush; read fresh map above
  const relayAlive = useRelayAlive();
  // Ask the Kotak WS relay to push ticks for whatever's on screen — filters
  // rotate the symbol set constantly, so a static holdings/watchlist-only
  // subscription would miss Top Breakouts entirely.
  useEffect(() => { subscribeSymbolsForTicks(scoreKeys); }, [scoreKeysJoined]);
  const liveByKey = useMemo(() => {
    const m = new Map((scoreQuotes?.quotes ?? []).map((q) => [quoteKey(q.exchange, q.symbol), q]));
    for (const [key, tick] of Object.entries(pushTicks)) {
      if (!isFreshTick(tick)) continue;
      const base = m.get(key);
      const abs = deriveChangeAbs(tick.ltp, tick.change_pct);
      m.set(key, base
        ? { ...base, ltp: tick.ltp, change_pct: tick.change_pct, day_change: abs }
        : ({ ltp: tick.ltp, change_pct: tick.change_pct, day_change: abs } as any));
    }
    return m;
  }, [scoreQuotes, pushTicks]);
  const liveFor = (s: BreakoutDisplayRow) => liveByKey.get(rowKey(s));
  const anyPush = useMemo(() => scoreKeys.some((k) => isFreshTick(pushTicks[k])), [scoreKeys, pushTicks]);
  // Provider-aware live state — reads the batch-level `provider` summary the
  // edge function now returns (kotak / yahoo / mixed / cache / none). This
  // replaces the old "any stale row → delayed" heuristic that mislabeled
  // Kotak-fulfilled batches when Yahoo backfilled a handful of symbols.
  const quoteProvider = (scoreQuotes as any)?.provider as
    | "kotak" | "yahoo" | "mixed" | "cache" | "none" | undefined;
  const liveQuoteState = useMemo<"push" | "kotak" | "mixed" | "yahoo" | "cache" | "closed" | "none">(() => {
    // Relay handshake OR any fresh push tick both prove the WS relay is up.
    if (anyPush || relayAlive) return "push";
    const quotes = scoreQuotes?.quotes ?? [];
    if (quotes.length === 0) return "none";
    if (quoteProvider === "kotak") return "kotak";
    if (quoteProvider === "mixed") return "mixed";
    if (quoteProvider === "cache") return nseOpenNow() ? "cache" : "closed";
    // Yahoo (or unknown) — during hours it's ~15m delayed, off-hours it's just the close.
    return nseOpenNow() ? "yahoo" : "closed";
  }, [scoreQuotes, anyPush, scoreKeys, quoteProvider, relayAlive]);

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

  // Portfolio day P&L — quote the held symbols with the same 1s live cadence.
  const { data: pfQuotes } = useQuery({
    queryKey: ["market", "dash-pf-quotes", (counts?.holdingRows ?? []).map((h) => h.symbol).join(",")],
    queryFn: async () => {
      const keys = Array.from(new Set((counts!.holdingRows).map((h) => `${h.exchange}:${h.symbol}`)));
      return callMarketFn<{ quotes: Quote[] }>("market-quotes", { symbols: keys });
    },
    enabled: (counts?.holdingRows.length ?? 0) > 0,
    refetchInterval: () => (nseOpenNow() ? 1_000 : false),
    placeholderData: (prev: unknown) => prev as any,
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
    for (const h of rows) {
      const q = byKey.get(quoteKey(h.exchange, h.symbol));
      const calc = holdingPnl({ quantity: h.quantity, avgPrice: h.avg_price, quote: q });
      invested += calc.invested;
      if (calc.current == null) { unresolved++; continue; }
      knownInvested += calc.invested;
      current += calc.current;
      if (q?.previous_close != null && q.previous_close > 0) {
        prevValue += q.previous_close * h.quantity;
        prevValueKnown = true;
        if (calc.todayPnl != null) dayPnlWithPrev += calc.todayPnl;
      }
    }
    // ₹ and % now share the same resolved-with-prev_close set — no more
    // "denominator from one subset, numerator from another" mismatch.
    const day = prevValueKnown ? dayPnlWithPrev : null;
    const dayPct = prevValueKnown && prevValue !== 0 ? (dayPnlWithPrev / prevValue) * 100 : null;
    const allUnresolved = unresolved === rows.length;
    return {
      invested: allUnresolved ? null : invested,
      current: allUnresolved ? null : current,
      pnl: allUnresolved ? null : current - knownInvested,
      day,
      dayPct,
      partial: unresolved > 0 && !allUnresolved,
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
    // Split cancelled (user-initiated) from rejected/failed (exchange or broker).
    const cancelled = orders.filter((o) => /cancel/i.test(o.status)).length;
    const rejected = orders.filter((o) => /reject|fail/i.test(o.status)).length;
    return { total: orders.length, open, executed, cancelled, rejected };
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


  // Prime-data pipeline is now hosted in Market Settings → Data Pipeline.


  // Top Breakouts columns mirror /market/screener — derived from the saved
  // screener's active filters, minus boolean filters (Yes/No values are
  // already conveyed by the filter chip itself). With no active saved filter,
  // fall back to a compact breakout table.
  const breakoutColumns = useMemo<ColumnDef<BreakoutDisplayRow, any>[]>(() => {
    const colMap = overviewColumnMap<BreakoutDisplayRow>((symbol) => nav(`/market/ai/${symbol}`));
    // Core columns always lead, in this fixed order, regardless of which
    // saved screener/filters are active — otherwise MCAP/breakout_score
    // silently disappear or reorder whenever the active filter set doesn't
    // happen to touch them.
    const CORE_IDS = ["symbol", "close", "change_pct", "market_cap", "breakout_score"];
    const ids = hasActiveFilters
      ? [...CORE_IDS, ...colsFromActiveFilters(selectedScreenState.active, {
          skipBooleans: true,
          allowedCols: OVERVIEW_COL_IDS,
        }).filter((id) => !CORE_IDS.includes(id))]
      : CORE_IDS;
    const seen = new Set<string>();
    const out: ColumnDef<BreakoutDisplayRow, any>[] = [];
    for (const id of ids) {
      if (seen.has(id) || !colMap[id]) continue;
      seen.add(id);
      out.push(colMap[id]);
    }
    out.push(colMap["actions"]);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedScreenState.active, hasActiveFilters, liveByKey]);





  // Manage-indices action removed from the strip; keeps the HUD line compact.
  void setManageOpen;


  // Price-feed status is admin-only and lives in /config/system-data. No
  // banner here — every user reads prices from the shared system Kotak feed.

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0, height: "100%" }}>
      <MarketStrip />


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
            <Chip tone="neutral">{breakoutCountLabel}</Chip>
            {/* MarketStrip's chip covers index/relay health; this one covers
                this panel's own rotating-symbol quote query, which has its
                own independent error/staleness state. */}
            <PriceSourceChip compact stale={scoreQuotesError} />
          </div>
        }
      >
        <DataTable
          columns={breakoutColumns}
          data={filteredBreakouts}
          onRowClick={(r) => nav(`/market/analysis/${r.symbol}`)}
          numbered
          maxHeight="100%"
          initialSort={[{ id: "breakout_score", desc: true }]}
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
            {/* Orders — one-line summary instead of a mini order-book. Full
                breakdown lives on /market/orders. */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                <Link to="/market/orders" style={{ color: "var(--text)", textDecoration: "none", fontSize: 12, letterSpacing: "0.04em" }}>Orders</Link>
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                  {orderSummary.total > 0 ? `${orderSummary.total} today` : "No orders today"}
                </span>
              </div>
              {orderSummary.total > 0 && (
                <div style={{ fontSize: 11, color: "var(--text-dim)", display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <span><span style={{ color: "var(--accent)" }}>{orderSummary.open}</span> open</span>
                  <span><span style={{ color: "var(--ok)" }}>{orderSummary.executed}</span> executed</span>
                  {orderSummary.cancelled > 0 && <span><span style={{ color: "var(--text)" }}>{orderSummary.cancelled}</span> cancelled</span>}
                  {orderSummary.rejected > 0 && <span><span style={{ color: "var(--danger)" }}>{orderSummary.rejected}</span> rejected</span>}
                </div>
              )}
            </div>
          </div>
        </HudPanel>
      </div>

      {manageOpen && (
        <ManageIndicesDialog
          onClose={() => setManageOpen(false)}
        />
      )}
    </div>
  );
}

function ManageIndicesDialog({ onClose }: { onClose: () => void }) {
  const push = useUi((s) => s.push);
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
      push("Invalid Yahoo symbol. Use uppercase letters, digits and any of ^ . _ = - (e.g. ^GSPC, NIFTY_MIDCAP_50.NS)", "err");
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

        {/* Prime-data pipeline moved to Market Settings → Data Pipeline. */}
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
