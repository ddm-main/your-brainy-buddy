// Stock Analysis — TradingView-style chart workbench + indicator readouts.
// Chart fills the viewport height; indicators are computed client-side in
// CandleChart, so toggles work even before the EOD pipeline has run.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState } from "@/components/hud/HudControls";
import { CandleChart, type ChartType } from "@/components/market/CandleChart";
import { TradingViewChart, tvInterval } from "@/components/market/TradingViewChart";
import { ScoreBadge } from "@/components/market/ScoreBadge";
import { ChartToolbar, DEFAULT_SETTINGS, type ChartSettings } from "@/components/market/ChartToolbar";
import { IndicatorSettingsModal } from "@/components/market/IndicatorSettingsModal";
import { NewAlertModal, StockAlertsPanel } from "@/components/market/StockAlerts";
import { DEFAULT_STUDIES, makeStudy, normalizeStudy, type IndicatorType, type Study } from "@/lib/market/indicatorRegistry";
import { fmtNum, fmtInt, fmtPct } from "@/components/hud/DataTable";
import { useBreadth, useCandles, useCorporateActions, useDepth, useFundamentals, useMarketNews, useQuotes, useRefreshStockInsight, useSectorStrength, useStockInsight, useStockScores, useSyncNewsAndActions } from "@/lib/market/hooks";
import { computeLiveScore } from "@/lib/market/liveSnapshot";
import { usePreferLiveTick } from "@/lib/market/useRealtimeTicks";
import { getTrustedDayChange } from "@/lib/market/pnl";
import { FullscreenShell } from "@/components/market/FullscreenShell";
import { useNotifications } from "@/store/notificationStore";
import { RefreshCw } from "lucide-react";

const STATE_STORE = "jarvis.analysis.state.v5";
const LAYOUTS_STORE = "jarvis.analysis.layouts.v1";
const INTRADAY_TFS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h"];

type Persisted = {
  tf: string;
  chartType: ChartType;
  tvMode: boolean;
  studies: Study[];
  settings: ChartSettings;
};

const defaultState: Persisted = {
  tf: "1D",
  chartType: "candles",
  tvMode: false,
  studies: DEFAULT_STUDIES,
  settings: DEFAULT_SETTINGS,
};

// Drop studies whose type no longer exists and backfill missing params/colours.
function loadStudies(saved: unknown): Study[] {
  if (!Array.isArray(saved)) return DEFAULT_STUDIES;
  const out = saved.map((s) => normalizeStudy(s as Study)).filter((s): s is Study => s != null);
  return out;
}

function loadState(): Persisted {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_STORE) ?? "{}");
    return {
      ...defaultState,
      ...raw,
      studies: loadStudies(raw.studies),
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    };
  } catch { return defaultState; }
}

export default function Analysis() {
  const { symbol } = useParams();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const exchange = (searchParams.get("exchange") ?? "NSE").toUpperCase() === "BSE" ? "BSE" : "NSE";
  const setExchange = (ex: "NSE" | "BSE") => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (ex === "NSE") next.delete("exchange"); else next.set("exchange", ex);
      return next;
    }, { replace: true });
  };
  const initial = useMemo(loadState, []);
  const [tf, setTf] = useState(initial.tf);
  const [chartType, setChartType] = useState<ChartType>(initial.chartType);
  const [tvMode, setTvMode] = useState(initial.tvMode);
  const [fs, setFs] = useState(false);
  const [studies, setStudies] = useState<Study[]>(initial.studies);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ChartSettings>(initial.settings);
  const [alertModalOpen, setAlertModalOpen] = useState(false);
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const notify = useNotifications((s) => s.add);

  const addStudy = useCallback((type: IndicatorType) => setStudies((s) => [...s, makeStudy(type)]), []);
  const toggleStudy = useCallback((id: string) => setStudies((s) => s.map((x) => (x.id === id ? { ...x, visible: !x.visible } : x))), []);
  const removeStudy = useCallback((id: string) => setStudies((s) => s.filter((x) => x.id !== id)), []);
  const updateStudy = useCallback((u: Study) => setStudies((s) => s.map((x) => (x.id === u.id ? u : x))), []);
  const resetStudies = useCallback(() => setStudies(DEFAULT_STUDIES), []);
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
    const payload: Persisted = { tf, chartType, tvMode, studies, settings };
    localStorage.setItem(STATE_STORE, JSON.stringify(payload));
  }, [tf, chartType, tvMode, studies, settings]);

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

  // `|| score.close`: a quote ltp of 0 means "no live quote" (Yahoo/Kotak
  // unavailable) — fall back to the EOD close from the score row so the panel
  // never shows ₹0. Change % falls back to the EOD change from the score.
  const ltp = quote?.ltp || score?.close || null;
  const chgPct = quote?.change_pct ?? score?.change_pct ?? null;
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
            <div style={{ display: "flex", gap: 4 }}>
              {(["NSE", "BSE"] as const).map((ex) => (
                <Btn key={ex} size="sm" variant={exchange === ex ? "primary" : "ghost"} onClick={() => setExchange(ex)}>
                  {ex}
                </Btn>
              ))}
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
              settings={settings}
              onSettings={(u) => setSettings(u)}
              tvMode={tvMode}
              onTvMode={setTvMode}
              onFullscreen={() => setFs(true)}
              onAlert={() => setAlertModalOpen(true)}
              onScreenshot={handleScreenshot}
              onSaveLayout={saveLayout}
              onLoadLayout={loadLayout}
              onDeleteLayout={deleteLayout}
              savedLayouts={savedLayouts}
            />
            <div ref={chartWrapRef} style={{ flex: 1, minHeight: 0 }}>
              {tvMode ? (
                <TradingViewChart symbol={sym} interval={tvInterval(tf)} />
              ) : error ? (
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
                  intraday={INTRADAY_TFS.includes(tf)}
                  livePrice={quote?.ltp || null}
                  onToggleStudy={toggleStudy}
                  onEditStudy={setEditingId}
                  onRemoveStudy={removeStudy}
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
          <div style={{ fontSize: 13, color: (chgPct ?? 0) >= 0 ? "var(--ok)" : "var(--danger)" }}>
            {chgPct != null ? fmtPct(chgPct) : "—"}
            {dayChange != null && <span style={{ marginLeft: 8 }}>({fmtNum(dayChange)})</span>}
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

        {depth && (depth.bids.length > 0 || depth.asks.length > 0) && (
          <HudPanel flow title="Market Depth" index="A2">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
              <div>
                <div className="hud-label" style={{ color: "var(--ok)", marginBottom: 4 }}>Bids</div>
                {depth.bids.map((b, i) => (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 6, padding: "2px 0", borderBottom: "1px solid var(--edge)" }}>
                    <span style={{ color: "var(--ok)" }}>{b.price.toFixed(2)}</span>
                    <span style={{ color: "var(--text-dim)", textAlign: "right" }}>{b.qty.toLocaleString("en-IN")}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="hud-label" style={{ color: "var(--danger)", marginBottom: 4 }}>Asks</div>
                {depth.asks.map((a, i) => (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 6, padding: "2px 0", borderBottom: "1px solid var(--edge)" }}>
                    <span style={{ color: "var(--danger)" }}>{a.price.toFixed(2)}</span>
                    <span style={{ color: "var(--text-dim)", textAlign: "right" }}>{a.qty.toLocaleString("en-IN")}</span>
                  </div>
                ))}
              </div>
            </div>
          </HudPanel>
        )}

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
            />
          </Row>
          <Row label="Pre-Breakout">
            <ScoreBadge
              score={liveScore?.prebreakout.score ?? score?.prebreakout_score}
              components={liveScore?.prebreakout.components ?? score?.score_components?.prebreakout}
              label="pre-breakout components"
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
              {fmtPct(liveScore?.snapshot.pctFrom52wHigh ?? score?.pct_from_52w_high)}
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

        {/* AI Verdict — cached 6h per symbol */}
        <HudPanel flow title="AI Verdict" index="A6"
          actions={
            <Btn size="sm" variant="ghost" disabled={!sym || refreshInsight.isPending}
              onClick={() => sym && refreshInsight.mutate({ symbol: sym })}
              aria-label="refresh AI verdict">
              <RefreshCw size={11} />
            </Btn>
          }>
          {insightLoading || refreshInsight.isPending ? (
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

        {/* Fundamentals */}
        {fund && (
          <HudPanel flow title="Fundamentals" index="A7">
            <Row label="Market Cap" mono>{fund.market_cap ? `₹${fmtNum(fund.market_cap / 1e7, 0)} Cr` : "—"}</Row>
            <Row label="P/E (TTM)" mono>{fmtNum(fund.pe_ttm, 2)}</Row>
            <Row label="P/B" mono>{fmtNum(fund.price_to_book, 2)}</Row>
            <Row label="EPS (TTM)" mono>{fmtNum(fund.eps_ttm, 2)}</Row>
            <Row label="ROE" mono>{fund.roe != null ? fmtPct(fund.roe * 100) : "—"}</Row>
            <Row label="Debt/Equity" mono>{fmtNum(fund.debt_to_equity, 2)}</Row>
            <Row label="Div Yield" mono>{fund.dividend_yield != null ? fmtPct(fund.dividend_yield * 100) : "—"}</Row>
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
