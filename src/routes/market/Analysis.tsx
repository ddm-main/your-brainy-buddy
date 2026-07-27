// Stock Analysis — TradingView-style chart workbench + indicator readouts.
// Chart fills the viewport height; indicators are computed client-side in
// CandleChart, so toggles work even before the EOD pipeline has run.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { pickNsePreferredListing } from "@/lib/market/exchangePreference";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState } from "@/components/hud/HudControls";
import { CandleChart, type ChartType } from "@/components/market/CandleChart";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { ChartToolbar, DEFAULT_SETTINGS, isIntraday, rangeToBars, type ChartRange, type ChartSettings } from "@/components/market/ChartToolbar";
import { IndicatorSettingsModal } from "@/components/market/IndicatorSettingsModal";
import { NewAlertModal, StockAlertsPanel } from "@/components/market/StockAlerts";
import { DEFAULT_STUDIES, makeStudy, normalizeStudy, type IndicatorType, type Study } from "@/lib/market/indicatorRegistry";
import { fmtNum, fmtInt, fmtPct, Return1DCell, deriveChangeAbs } from "@/components/hud/DataTable";
import { useBreadth, useCandles, useCorporateActions, useDepth, useFundamentals, useMarketNews, useQuotes, useRefreshStockInsight, useSectorStrength, useStockInsight, useStockScores, useSyncNewsAndActions } from "@/lib/market/hooks";
import { MarketDepthLadder } from "@/components/market/MarketDepthLadder";
import { computeLiveScore } from "@/lib/market/liveSnapshot";
import { subscribeSymbolsForTicks, usePreferLiveTick } from "@/lib/market/useRealtimeTicks";
import { getTrustedDayChange } from "@/lib/market/pnl";
import { FullscreenShell } from "@/components/market/FullscreenShell";
import { useNotifications } from "@/store/notificationStore";
import { RefreshCw } from "lucide-react";

const STATE_STORE = "jarvis.analysis.state.v5";
const LAYOUTS_STORE = "jarvis.analysis.layouts.v1";
// Per-symbol chart preferences (TF/chartType) — lets users keep
// e.g. NIFTY on 1h and RELIANCE on 15m. Falls back to STATE_STORE.
const TF_STORE_PREFIX = "jarvis.analysis.tf.";
const tfKey = (exch: string, sym: string | undefined) =>
  `${TF_STORE_PREFIX}${(exch || "NSE").toUpperCase()}:${(sym || "").toUpperCase()}`;


type Persisted = {
  tf: string;
  chartType: ChartType;
  studies: Study[];
  settings: ChartSettings;
  range: ChartRange;
};

const defaultState: Persisted = {
  tf: "1D",
  chartType: "candles",
  studies: DEFAULT_STUDIES,
  settings: DEFAULT_SETTINGS,
  range: "1Y",
};

// Drop studies whose type no longer exists and backfill missing params/colours.
function loadStudies(saved: unknown): Study[] {
  if (!Array.isArray(saved)) return DEFAULT_STUDIES;
  // Wrap per-item so ONE bad entry can't nuke the whole state and reset TF
  // to 1D on refresh.
  const out: Study[] = [];
  for (const s of saved) {
    try {
      const n = normalizeStudy(s as Study);
      if (n) out.push(n);
    } catch { /* skip malformed study */ }
  }
  // Self-heal: ensure a volume study is always present so it renders on
  // every chart even for old saved states created before volume was default.
  if (!out.some((x) => x.type === "volume")) out.unshift(makeStudy("volume"));
  return out;
}

function loadState(): Persisted {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_STORE) ?? "{}") as Partial<Persisted>;
    return {
      ...defaultState,
      ...raw,
      studies: loadStudies(raw.studies),
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    };
  } catch { return defaultState; }
}

export default function Analysis() {
  const nav = useNavigate();
  const { symbol } = useParams();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  // Exchange is resolved automatically: NSE when the symbol is listed there,
  // BSE only when it isn't. An explicit ?exchange= param (deep links from other
  // screens) still wins. No manual toggle — one listing, one chart.
  const paramExchange = searchParams.get("exchange")?.toUpperCase();
  const forcedExchange: "NSE" | "BSE" | null =
    paramExchange === "BSE" ? "BSE" : paramExchange === "NSE" ? "NSE" : null;
  const { data: listedExchange } = useQuery({
    queryKey: ["market", "listing-exchange", symbol?.toUpperCase()],
    enabled: !!symbol && !forcedExchange,
    staleTime: 60 * 60 * 1000,
    queryFn: async () => {
      const { data } = await supabase
        .from("market_stocks")
        .select("exchange")
        .eq("symbol", symbol!.toUpperCase())
        .eq("is_active", true);
      const rows = (data ?? []) as { exchange: string }[];
      return pickNsePreferredListing(rows)?.exchange?.toUpperCase() === "BSE" ? "BSE" : "NSE";
    },
  });
  const exchange: "NSE" | "BSE" = forcedExchange ?? listedExchange ?? "NSE";

  const initial = useMemo(loadState, []);
  // Per-symbol TF/chartType override wins over the global state so
  // switching between symbols keeps each one's preferred view.
  const perSymbolInitial = useMemo(() => {
    try {
      const raw = localStorage.getItem(tfKey(exchange, symbol));
      if (!raw) return null;
      return JSON.parse(raw) as { tf?: string; chartType?: ChartType };
    } catch { return null; }
    // symbol/exchange change → recompute; safe: state below re-inits from this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, exchange]);
  const [tf, setTf] = useState(perSymbolInitial?.tf ?? initial.tf);
  const [chartType, setChartType] = useState<ChartType>(perSymbolInitial?.chartType ?? initial.chartType);
  const [fs, setFs] = useState(false);
  const [studies, setStudies] = useState<Study[]>(initial.studies);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ChartSettings>(initial.settings);
  // Viewport range for daily/weekly/monthly charts. The full series is always
  // fetched; this only decides how much of it is visible on load.
  const [range, setRange] = useState<ChartRange>(initial.range ?? "1Y");
  const [alertModalOpen, setAlertModalOpen] = useState(false);
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const notify = useNotifications((s) => s.add);

  const addStudy = useCallback((type: IndicatorType) => setStudies((s) => [...s, makeStudy(type)]), []);
  const toggleStudy = useCallback((id: string) => setStudies((s) => s.map((x) => (x.id === id ? { ...x, visible: !x.visible } : x))), []);
  const removeStudy = useCallback((id: string) => setStudies((s) => s.filter((x) => x.id !== id)), []);
  const updateStudy = useCallback((u: Study) => setStudies((s) => s.map((x) => (x.id === u.id ? u : x))), []);
  const resetStudies = useCallback(() => {
    if (!window.confirm("Reset all indicators to defaults? This removes any studies you've added.")) return;
    setStudies(DEFAULT_STUDIES);
  }, []);
  const editing = studies.find((s) => s.id === editingId) ?? null;
  const visibleStudyCount = useMemo(() => studies.filter((s) => s.visible).length, [studies]);

  const [savedLayouts, setSavedLayouts] = useState<string[]>(() => {
    try { return Object.keys(JSON.parse(localStorage.getItem(LAYOUTS_STORE) ?? "{}")); } catch { return []; }
  });
  const saveLayout = useCallback((name: string) => {
    try {
      const all = JSON.parse(localStorage.getItem(LAYOUTS_STORE) ?? "{}");
      all[name] = { tf, chartType, studies, settings };
      localStorage.setItem(LAYOUTS_STORE, JSON.stringify(all));
      setSavedLayouts(Object.keys(all));
      notify(`Layout "${name}" saved`);
    } catch { notify("Could not save layout"); }
  }, [tf, chartType, studies, settings, notify]);
  const loadLayout = useCallback((name: string) => {
    try {
      const all = JSON.parse(localStorage.getItem(LAYOUTS_STORE) ?? "{}");
      const l = all[name];
      if (!l) return;
      if (l.tf) setTf(l.tf);
      if (l.chartType) setChartType(l.chartType);
      if (Array.isArray(l.studies)) setStudies(loadStudies(l.studies));
      if (l.settings) setSettings({ ...DEFAULT_SETTINGS, ...l.settings });
      notify(`Layout "${name}" loaded`);
    } catch { notify("Could not load layout"); }
  }, [notify]);
  const deleteLayout = useCallback((name: string) => {
    try {
      const all = JSON.parse(localStorage.getItem(LAYOUTS_STORE) ?? "{}");
      delete all[name];
      localStorage.setItem(LAYOUTS_STORE, JSON.stringify(all));
      setSavedLayouts(Object.keys(all));
    } catch { /* noop */ }
  }, []);

  useEffect(() => {
    const payload: Persisted = { tf, chartType, studies, settings, range };
    localStorage.setItem(STATE_STORE, JSON.stringify(payload));
  }, [tf, chartType, studies, settings, range]);

  // Per-symbol chart prefs (TF/chartType). Written on change AND on
  // beforeunload so a fast refresh right after switching TF still catches it.
  useEffect(() => {
    if (!symbol) return;
    const key = tfKey(exchange, symbol);
    const payload = { tf, chartType };
    try { localStorage.setItem(key, JSON.stringify(payload)); } catch { /* quota */ }
    const onBeforeUnload = () => {
      try {
        localStorage.setItem(key, JSON.stringify(payload));
        localStorage.setItem(STATE_STORE, JSON.stringify({ tf, chartType, studies, settings }));
      } catch { /* noop */ }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [symbol, exchange, tf, chartType, studies, settings]);

  // F toggles fullscreen when not typing in an input
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "f" && e.key !== "F") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (fs) return;
      setFs(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fs]);

  const sym = symbol?.toUpperCase();

  const handleScreenshot = useCallback(() => {
    const wrap = chartWrapRef.current;
    if (!wrap) return;
    const canvases = wrap.querySelectorAll("canvas");
    if (canvases.length === 0) { notify("Chart not ready for screenshot"); return; }
    const rects = Array.from(canvases).map((c) => c.getBoundingClientRect());
    const wrapRect = wrap.getBoundingClientRect();
    const out = document.createElement("canvas");
    out.width = Math.ceil(wrapRect.width * devicePixelRatio);
    out.height = Math.ceil(wrapRect.height * devicePixelRatio);
    const ctx = out.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--bg").trim() || "#050b12";
    ctx.fillRect(0, 0, out.width, out.height);
    canvases.forEach((c, i) => {
      const r = rects[i];
      const x = (r.left - wrapRect.left) * devicePixelRatio;
      const y = (r.top - wrapRect.top) * devicePixelRatio;
      try { ctx.drawImage(c, x, y, r.width * devicePixelRatio, r.height * devicePixelRatio); } catch {}
    });
    // Composite the DOM overlay (symbol/TF caption) — the OHLC/legend divs
    // aren't part of the canvas, so exports would otherwise lose them.
    const stamp = `${sym ?? "chart"} · ${tf} · ${new Date().toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`;
    ctx.font = `${12 * devicePixelRatio}px system-ui, sans-serif`;
    ctx.textBaseline = "top";
    const pad = 8 * devicePixelRatio;
    const textW = ctx.measureText(stamp).width;
    ctx.fillStyle = "rgba(4,16,22,0.75)";
    ctx.fillRect(pad - 4, pad - 4, textW + 12, 20 * devicePixelRatio);
    ctx.fillStyle = "#7fe9ff";
    ctx.fillText(stamp, pad, pad);
    out.toBlob((blob) => {
      if (!blob) { notify("Screenshot failed"); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${sym ?? "chart"}-${tf}-${new Date().toISOString().slice(0, 10)}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      notify("Chart screenshot saved");
    }, "image/png");
  }, [tf, sym, notify]);

  const { data: candleData, isLoading, error } = useCandles(sym, tf, exchange);

  const { data: scores = [] } = useStockScores({ symbol: sym, limit: 1 });
  const score = scores[0];
  const { data: quotesData } = useQuotes(sym ? [`${exchange}:${sym}`] : []);
  useEffect(() => {
    if (!sym) return;
    subscribeSymbolsForTicks([`${exchange}:${sym}`]);
  }, [exchange, sym]);
  const restQuote = quotesData?.quotes?.[0];
  const preferred = usePreferLiveTick(sym ? `${exchange}:${sym}` : null, restQuote ? { ltp: restQuote.ltp, change_pct: restQuote.change_pct } : null);
  // `quote` keeps its REST shape (source/stale/day_change) for the rest of the
  // page; only ltp/change_pct are overridden when a fresher push tick exists.
  const quote = restQuote && preferred ? { ...restQuote, ltp: preferred.ltp, change_pct: preferred.change_pct } : restQuote;
  const { data: breadth } = useBreadth();
  // Daily candles independent of the chart's selected timeframe (`tf` may be
  // intraday) — this is what the live technical recompute always uses.
  const { data: dailyCandleData } = useCandles(sym, "1D", exchange);
  const liveScore = useMemo(
    () => computeLiveScore(dailyCandleData?.candles, quote, score, breadth),
    [dailyCandleData, quote, score, breadth],
  );
  const { data: sectors = [] } = useSectorStrength();
  const { data: depth } = useDepth(sym, exchange);
  const { data: fundData } = useFundamentals(sym, exchange);
  const fund = fundData?.fundamentals as any | undefined;
  const { data: insightData, isLoading: insightLoading, error: insightError } = useStockInsight(sym);
  const refreshInsight = useRefreshStockInsight();
  const { data: news = [] } = useMarketNews(sym, exchange);
  const { data: corpActions = [] } = useCorporateActions(sym, exchange);
  const syncNews = useSyncNewsAndActions();
  const insight = insightData?.payload;
  const sectorRow = useMemo(
    () => sectors.find((s) => s.sector === score?.sector),
    [sectors, score],
  );

  // Count of active alerts on this symbol, sourced from the same query key
  // StockAlertsPanel writes to so the toolbar badge stays in sync without
  // an extra network round-trip.
  const { data: alertsForBadge = [] } = useQuery({
    queryKey: ["market", "alerts", sym, exchange],
    queryFn: async () => {
      const { data, error } = await supabase.from("market_alerts")
        .select("id,is_active")
        .eq("symbol", sym!).eq("exchange", exchange);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!sym,
  });
  const alertCount = (alertsForBadge as Array<{ is_active: boolean }>).filter((a) => a.is_active).length;

  // Auto-sync news on first open for a symbol that has none cached. Guarded
  // by a ref keyed on symbol|exchange so revisits or React StrictMode
  // double-mount don't spam Yahoo.
  const autoSyncedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sym) return;
    const key = `${sym}:${exchange}`;
    if (autoSyncedRef.current === key) return;
    if (news.length > 0 || syncNews.isPending) return;
    autoSyncedRef.current = key;
    syncNews.mutate({ symbol: sym, exchange });
  }, [sym, exchange, news.length, syncNews]);

  const priceLines = useMemo(() => {
    const lines: Array<{ price: number; label: string; color: string }> = [];
    const r = liveScore?.snapshot.resistance ?? score?.resistance_level ?? null;
    const s = liveScore?.snapshot.support ?? score?.support_level ?? null;
    const rFallback = liveScore?.snapshot.resistanceFallback ?? false;
    const sFallback = liveScore?.snapshot.supportFallback ?? false;
    if (r) lines.push({ price: r, label: rFallback ? "R*" : "R", color: "#ffb84d" });
    if (s) lines.push({ price: s, label: sFallback ? "S*" : "S", color: "#6bffb0" });
    return lines;
  }, [liveScore, score]);

  // No standalone "Analysis" destination — this view is always reached by
  // clicking a symbol elsewhere. A missing/invalid param sends the user back
  // to Screener rather than showing a manual symbol-search landing page.
  if (!sym) {
    return <Navigate to="/market/screener" replace />;
  }

  // Prefer EOD close when the live quote is stale (Yahoo timeout / Kotak
  // disconnect) — a stale quote was silently overriding the fresh EOD close
  // and turning the header green with a phantom 0% change.
  const staleLive = !!quote?.stale;
  const ltp = (!staleLive && quote?.ltp) || score?.close || null;
  const chgPct = (!staleLive ? quote?.change_pct : null) ?? score?.change_pct ?? null;
  const dayChange = getTrustedDayChange(quote);

  return (
    <div className="mk-anl-grid">
      {/* Chart column — fills the viewport height */}
      <div className="mk-anl-chart" style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
        <HudPanel
          title={sym}
          index="MK.ANL"
          live={isLoading ? "warn" : "ok"}
          style={{ flex: 1, minHeight: 0 }}
          actions={
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              {/* Provider provenance is shown on the chart itself ("yahoo · delayed") — no duplicate chip here. */}
              <Chip tone="neutral">{exchange}</Chip>
            </div>

          }
        >
          <FullscreenShell fullscreen={fs} onExit={() => setFs(false)} title={`${sym} · ${tf}`}>
            <ChartToolbar
              symbol={sym}
              exchange={exchange}
              tf={tf}
              onTf={setTf}
              chartType={chartType}
              onChartType={setChartType}
              onAddStudy={addStudy}
              onResetStudies={resetStudies}
              studyCount={visibleStudyCount}
              totalStudyCount={studies.length}
              settings={settings}
              onSettings={(u) => setSettings(u)}
              onFullscreen={() => setFs(true)}
              onAlert={() => setAlertModalOpen(true)}
              alertCount={alertCount}
              onScreenshot={handleScreenshot}
              onSaveLayout={saveLayout}
              onLoadLayout={loadLayout}
              onDeleteLayout={deleteLayout}
              savedLayouts={savedLayouts}
              intraday={isIntraday(tf)}
              range={range}
              onRange={setRange}
            />
            <div ref={chartWrapRef} style={{ flex: 1, minHeight: 0 }}>
              {error ? (
                <EmptyState hint={String((error as Error).message ?? "")}>chart unavailable</EmptyState>
              ) : isLoading || !candleData ? (
                <div className="hud-label" style={{ padding: 24, textAlign: "center" }}>loading candles…</div>
              ) : candleData.candles.length === 0 ? (
                <EmptyState hint="unknown symbol, or data pipeline hasn't covered it yet">no candle data</EmptyState>
              ) : (
                <CandleChart
                  candles={candleData.candles}
                  priceLines={priceLines}
                  fill
                  chartType={chartType}
                  studies={studies}
                  intraday={isIntraday(tf)}
                  livePrice={!staleLive ? (quote?.ltp ?? null) : null}
                  liveVolume={!staleLive ? ((quote as any)?.volume ?? null) : null}
                  settings={settings}
                  onToggleStudy={toggleStudy}
                  onEditStudy={setEditingId}
                  onRemoveStudy={removeStudy}
                  source={candleData.provider ?? null}
                  visibleBars={isIntraday(tf) ? null : rangeToBars(range, tf)}
                />


              )}
            </div>

          </FullscreenShell>
          <IndicatorSettingsModal study={editing} onChange={updateStudy} onRemove={removeStudy} onClose={() => setEditingId(null)} />
        </HudPanel>
      </div>

      {/* Right rail — scrolls independently */}
      <div className="mk-anl-rail">
        <HudPanel flow title="Quote" index="A1">
          <div style={{ fontFamily: "var(--font-display)", fontSize: 26, color: "var(--accent)" }}>
            {ltp != null ? `₹${fmtNum(ltp)}` : "—"}
          </div>
          <div style={{ fontSize: 13 }}>
            <Return1DCell abs={dayChange ?? deriveChangeAbs(ltp, chgPct)} pct={chgPct} />
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
            {score?.sector && <Chip tone="accent">{score.sector}</Chip>}
            {quote?.ltp && liveScore ? (
              <Chip tone="ok">live · technicals updating</Chip>
            ) : !quote?.ltp && score?.close != null ? (
              <span style={{ fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.1em" }}>EOD</span>
            ) : null}
            {quote?.stale && <Chip tone="warn">stale</Chip>}
          </div>
        </HudPanel>

        <StockAlertsPanel symbol={sym} exchange={exchange} />

        <MarketDepthLadder depth={depth} />

        {!score ? (
          <HudPanel flow title="Coverage" index="A3">
            <div className="hud-label" style={{ fontSize: 11, lineHeight: 1.6, color: "var(--text-dim)" }}>
              No screener data for <b style={{ color: "var(--accent)" }}>{sym}</b>. It isn't in the
              tracked universe yet — run the pipeline from <span style={{ color: "var(--accent)" }}>Settings → Sync universe</span>,
              or pick a covered symbol. The chart above still works.
            </div>
          </HudPanel>
        ) : (
        <>
        <HudPanel flow title="Breakout Intelligence" index="A3" actions={liveScore ? <Chip tone="ok">live</Chip> : undefined}>
          <Row label="Breakout">
            <ScoreBadge
              score={liveScore?.breakout.score ?? score?.breakout_score}
              components={liveScore?.breakout.components ?? score?.score_components?.breakout}
              label="breakout components"
              onClick={() => nav(`/market/ai/${sym}`)}
            />
          </Row>
          <Row label="Pre-Breakout">
            <ScoreBadge
              score={liveScore?.prebreakout.score ?? score?.prebreakout_score}
              components={liveScore?.prebreakout.components ?? score?.score_components?.prebreakout}
              label="pre-breakout components"
              onClick={() => nav(`/market/ai/${sym}`)}
            />
          </Row>
          <Row label="Setups">
            <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {(liveScore?.snapshot.bbSqueeze ?? score?.bb_squeeze) && <Chip tone="accent">BB squeeze</Chip>}
              {(liveScore?.snapshot.higherLows ?? score?.higher_lows) && <Chip tone="ok">higher lows</Chip>}
              {(liveScore?.snapshot.nearResistance ?? score?.near_resistance) && <Chip tone="warn">near resistance</Chip>}
              {(liveScore?.snapshot.aboveEma200 ?? score?.above_ema200) && <Chip tone="ok">&gt;200 EMA</Chip>}
              {!score && !liveScore && <span style={{ color: "var(--text-muted)", fontSize: 11 }}>pipeline pending</span>}
            </span>
          </Row>
          <Row label="Resistance" mono>
            {fmtNum(liveScore?.snapshot.resistance ?? score?.resistance_level)}
            {liveScore?.snapshot.resistanceTouches ? (
              <span style={{ color: "var(--text-muted)", fontSize: 10, marginLeft: 6 }}>
                {liveScore.snapshot.resistanceTouches}×{liveScore.snapshot.resistanceFallback ? " • range hi" : ""}
              </span>
            ) : null}
          </Row>
          <Row label="Support" mono>
            {fmtNum(liveScore?.snapshot.support ?? score?.support_level)}
            {liveScore?.snapshot.supportTouches ? (
              <span style={{ color: "var(--text-muted)", fontSize: 10, marginLeft: 6 }}>
                {liveScore.snapshot.supportTouches}×{liveScore.snapshot.supportFallback ? " • range lo" : ""}
              </span>
            ) : null}
          </Row>
        </HudPanel>

        <HudPanel flow title="Indicators (Daily)" index="A4" actions={liveScore ? <Chip tone="ok">live</Chip> : undefined}>
          <Row label="RSI (14)" mono>{fmtNum(liveScore?.snapshot.rsi14 ?? score?.rsi14, 1)}</Row>
          <Row label="MACD" mono>
            {fmtNum(liveScore?.snapshot.macd ?? score?.macd, 2)} / {fmtNum(liveScore?.snapshot.macdSignal ?? score?.macd_signal, 2)}
          </Row>
          <Row label="ADX (14)" mono>{fmtNum(liveScore?.snapshot.adx14 ?? score?.adx14, 1)}</Row>
          <Row label="ATR %" mono>{fmtNum(liveScore?.snapshot.atrPct ?? score?.atr_pct, 2)}</Row>
          <Row label="BB Width" mono>{fmtNum(liveScore?.snapshot.bbWidth ?? score?.bb_width, 3)}</Row>
          <Row label="Rel Volume" mono>{fmtNum(liveScore?.snapshot.relVolume ?? score?.rel_volume, 2)}</Row>
          <Row label="Volume" mono>{fmtInt(liveScore?.snapshot.volume ?? score?.volume)}</Row>
        </HudPanel>

        <HudPanel flow title="Range & Strength" index="A5">
          <Row label="52w High" mono>{fmtNum(liveScore?.snapshot.high52w ?? score?.high_52w)}</Row>
          <Row label="52w Low" mono>{fmtNum(liveScore?.snapshot.low52w ?? score?.low_52w)}</Row>
          <Row label="From 52w High" mono>
            <span style={{ color: (liveScore?.snapshot.pctFrom52wHigh ?? score?.pct_from_52w_high ?? 0) > -5 ? "var(--ok)" : "var(--text)" }}>
              {fmtPct(liveScore?.snapshot.pctFrom52wHigh ?? score?.pct_from_52w_high, 2, false)}
            </span>
          </Row>
          <Row label="RS vs NIFTY" mono>{fmtNum(score?.rel_strength_nifty, 1)}</Row>
          <Row label="Sector Rank" mono>
            {sectorRow?.strength_rank != null ? `#${sectorRow.strength_rank} of ${sectors.length}` : "—"}
          </Row>
          <Row label="EMA 20/50/200" mono>
            <span style={{ fontSize: 10 }}>
              {fmtNum(liveScore?.snapshot.ema20 ?? score?.ema20, 0)} / {fmtNum(liveScore?.snapshot.ema50 ?? score?.ema50, 0)} / {fmtNum(liveScore?.snapshot.ema200 ?? score?.ema200, 0)}
            </span>
          </Row>
        </HudPanel>
        </>
        )}

        {/* AI Verdict — cached 6h per symbol. refreshInsight is one shared
            mutation instance; scope its pending state to the symbol
            actually in flight so navigating to a different symbol mid-refresh
            doesn't show a stale "analyzing…" for the wrong one. */}
        {(() => { const refreshingThis = refreshInsight.isPending && refreshInsight.variables?.symbol === sym; return (
        <HudPanel flow title="AI Verdict" index="A6"
          actions={
            <Btn size="sm" variant="ghost" disabled={!sym || refreshingThis}
              onClick={() => sym && refreshInsight.mutate({ symbol: sym })}
              aria-label="refresh AI verdict">
              <RefreshCw size={11} />
            </Btn>
          }>
          {insightLoading || refreshingThis ? (
            <div className="hud-label" style={{ fontSize: 11, color: "var(--text-muted)" }}>analyzing…</div>
          ) : insightError ? (
            <div className="hud-label" style={{ fontSize: 11, color: "var(--danger)" }}>
              {(insightError as Error).message.includes("no coverage")
                ? "no coverage — run pipeline"
                : "AI unavailable — try refresh"}
            </div>
          ) : insight ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <Chip tone={insight.verdict === "buy" ? "ok" : insight.verdict === "avoid" ? "err" : insight.verdict === "wait" ? "warn" : "accent"}>
                  {insight.verdict.toUpperCase()}
                </Chip>
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                  conf {Math.round(insight.confidence * 100)}%
                </span>
              </div>
              {(insight.entry || insight.stop_loss || insight.targets.length > 0) && (
                <div style={{ display: "flex", flexDirection: "column", fontSize: 11, marginBottom: 6 }}>
                  {insight.entry != null && <Row label="Entry" mono>₹{fmtNum(insight.entry, 2)}</Row>}
                  {insight.stop_loss != null && <Row label="Stop" mono>₹{fmtNum(insight.stop_loss, 2)}</Row>}
                  {insight.targets.map((t, i) => (
                    <Row key={i} label={`T${i + 1}`} mono>₹{fmtNum(t, 2)}</Row>
                  ))}
                  {insight.holding_period_days != null && (
                    <Row label="Hold" mono>{insight.holding_period_days}d</Row>
                  )}
                </div>
              )}
              <div style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text)", marginBottom: 4 }}>
                {insight.rationale}
              </div>
              {insight.risks.length > 0 && (
                <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
                  <div className="hud-label" style={{ marginBottom: 2 }}>Risks</div>
                  <ul style={{ margin: 0, paddingLeft: 14 }}>
                    {insight.risks.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <div className="hud-label" style={{ fontSize: 11, color: "var(--text-muted)" }}>press refresh</div>
          )}
        </HudPanel>
        ); })()}

        {/* Fundamentals */}
        {fund && (
          <HudPanel flow title="Fundamentals" index="A7">
            <Row label="Market Cap" mono>{fund.market_cap ? `₹${fmtNum(fund.market_cap / 1e7, 0)} Cr` : "—"}</Row>
            <Row label="P/E (TTM)" mono>{fmtNum(fund.pe_ttm, 2)}</Row>
            <Row label="P/B" mono>{fmtNum(fund.price_to_book, 2)}</Row>
            <Row label="EPS (TTM)" mono>{fmtNum(fund.eps_ttm, 2)}</Row>
            <Row label="ROE" mono>{fund.roe != null ? fmtPct(fund.roe * 100, 2, false) : "—"}</Row>
            <Row label="Debt/Equity" mono>{fmtNum(fund.debt_to_equity, 2)}</Row>
            <Row label="Div Yield" mono>{(() => {
              const raw = fund.dividend_yield;
              if (raw == null) return "—";
              // Belt-and-braces guard against the FMP-percent-vs-Yahoo-decimal
              // unit clash — anything > 0.5 (i.e. >50% yield) is unrealistic
              // and must already be in percent; scale it back to decimal so
              // the display *100 lands correctly. The edge fn does the same
              // fix at write time; this catches any stale rows already cached.
              const dec = raw > 0.5 ? raw / 100 : raw;
              return fmtPct(dec * 100, 2, false);
            })()}</Row>
            <Row label="Beta" mono>{fmtNum(fund.beta, 2)}</Row>
            {fund.sector && <Row label="Sector">{fund.sector}</Row>}
            {fund.industry && <Row label="Industry">{fund.industry}</Row>}
          </HudPanel>
        )}

        {/* News & Corporate Actions — synced on demand, not on a universe-wide cron */}
        <HudPanel flow title="News & Corporate Actions" index="A8"
          actions={
            <Btn size="sm" variant="ghost" disabled={!sym || syncNews.isPending}
              onClick={() => sym && syncNews.mutate({ symbol: sym, exchange })}
              aria-label="sync news and corporate actions">
              <RefreshCw size={11} />
            </Btn>
          }>
          {corpActions.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div className="hud-label" style={{ marginBottom: 4 }}>Corporate Actions</div>
              {corpActions.map((a) => (
                <Row key={a.id} label={a.action_type} mono>
                  {a.ex_date ? new Date(a.ex_date).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" }) : "—"}
                  {a.details?.subject && <span style={{ color: "var(--text-dim)", marginLeft: 6, fontSize: 10 }}>{a.details.subject}</span>}
                </Row>
              ))}
            </div>
          )}
          {news.length === 0 ? (
            <div className="hud-label" style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {syncNews.isPending ? "syncing…" : "no news synced yet — press refresh"}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {news.map((n) => (
                <a key={n.id} href={n.url ?? undefined} target="_blank" rel="noreferrer"
                  style={{ fontSize: 11, color: "var(--text)", textDecoration: "none", display: "block" }}>
                  <div>{n.headline}</div>
                  <div style={{ color: "var(--text-dim)", fontSize: 10, marginTop: 2 }}>
                    {n.source ?? "Yahoo Finance"}{n.published_at ? ` · ${new Date(n.published_at).toLocaleDateString([], { day: "2-digit", month: "short" })}` : ""}
                  </div>
                </a>
              ))}
            </div>
          )}
        </HudPanel>
      </div>

      {alertModalOpen && (
        <NewAlertModal symbol={sym} exchange={exchange} onClose={() => setAlertModalOpen(false)}
          onCreated={() => { qc.invalidateQueries({ queryKey: ["market", "alerts", sym, exchange] }); setAlertModalOpen(false); }} />
      )}
    </div>
  );
}

function Row({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid var(--edge)", fontSize: 12 }}>
      <span className="hud-label" style={{ color: "var(--text-dim)" }}>{label}</span>
      <span style={mono ? { fontVariantNumeric: "tabular-nums", color: "var(--text)" } : undefined}>{children}</span>
    </div>
  );
}
