// lightweight-charts workbench themed for the HUD.
// Renders price (candles/bars/line/area) + a list of indicator "studies".
// Overlays draw on the price pane; oscillators each get their own sub-pane.
// Each study carries its own params/source/colours/width (see indicatorRegistry).
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  createSeriesMarkers,
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  CrosshairMode,
  TickMarkType,


  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type UTCTimestamp,
} from "lightweight-charts";

import type { CandleDto } from "@/lib/market/types";
import {
  ad, adx, ao, atr, bollingerV, cci, chaikinOsc, cmf, demaV, donchian, emaV, envelopesV,
  hmaV, ichimoku, keltner, macd, mfi, mom, obvWithMa, psar, roc, rsi, smaV, sourceValues,
  stochastic, stochRsi, stddevV, supertrend, temaV, trix, uo, vortex, vwap, vwma, williamsR,
  wmaV, aroon, type Num,
} from "@/lib/market/chartIndicators";
import { defByType, studyLabel, type Study } from "@/lib/market/indicatorRegistry";
import { VolumeProfilePrimitive } from "@/components/market/volumeProfilePrimitive";
import {
  detectPatternSeries, type CandleMark, type ChartShape,
} from "../../../supabase/functions/_shared/market/pattern-series";
import { detailFromParam, tierAllows, tierOf } from "@/lib/market/patternLabels";
import { ChartLegend, type LegendRow } from "@/components/market/ChartLegend";
import { useMarketOpen } from "@/lib/market/useMarketOpen";
import { safeStorage } from "@/lib/safeStorage";


export type ChartType = "candles" | "bars" | "line" | "area" | "heikin_ashi" | "baseline";

// Bars of empty space kept to the right of the newest candle (TradingView's
// `rightOffset`). Programmatic ranges add it too so the live bar never gets
// welded to the right border.
const RIGHT_AIR = 8;


// Chart colour tokens — resolved once from CSS custom properties so the whole
// canvas stays theme-aware. lightweight-charts wants concrete strings, not
// var(...) references, so we read them at chart-build time (see readTokens()).
function readTokens() {
  if (typeof window === "undefined") {
    return {
      up: "#6bffb0", down: "#ff5f6d",
      upFill: "rgba(107,255,176,0.55)", downFill: "rgba(255,95,109,0.55)",
      neutral: "#f7c948",
    };
  }
  const cs = getComputedStyle(document.body);
  const g = (name: string, fallback: string) => (cs.getPropertyValue(name).trim() || fallback);
  return {
    up: g("--chart-up", "#6bffb0"),
    down: g("--chart-down", "#ff5f6d"),
    upFill: g("--chart-up-fill", "rgba(107,255,176,0.55)"),
    downFill: g("--chart-down-fill", "rgba(255,95,109,0.55)"),
    neutral: g("--chart-neutral", "#f7c948"),
  };
}
// Legacy inline refs for the render header — read once per render.
const TOKENS_FALLBACK = { up: "#6bffb0", down: "#ff5f6d" };
const UP = TOKENS_FALLBACK.up;
const DOWN = TOKENS_FALLBACK.down;

/** Fade a chart colour (hex or rgb/rgba) so secondary geometry reads as secondary. */
function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (rgb) {
    const [r, g, b] = rgb[1].split(",").map((v) => v.trim());
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return color;
}

// ---- per-study compute (pure) ----
// IST offset in seconds — used to find the start of the current trading day
// when splitting a day-cumulative volume across intraday bars.
const IST_OFFSET_SEC = 5.5 * 3600;

type Computed =
  | { g: "ma"; line: Num[] }
  | { g: "band"; upper: Num[]; mid: Num[]; lower: Num[] }
  | { g: "supertrend"; line: Num[]; dir: Array<1 | -1 | null> }
  | { g: "psar"; sar: Num[]; dir: Array<1 | -1 | null> }
  | { g: "ichimoku"; tenkan: Num[]; kijun: Num[]; spanA: Num[]; spanB: Num[]; base: number }
  | { g: "volume" }
  | { g: "patterns"; marks: CandleMark[] }
  | { g: "shapes"; shapes: ChartShape[] }
  | { g: "obv"; line: Num[]; ma: Num[] }
  | { g: "vprofile"; rows: number; valueAreaPct: number; widthPct: number; rightSide: boolean }
  | { g: "single"; line: Num[]; guides?: number[]; hist?: boolean }
  | { g: "macd"; macd: Num[]; signal: Num[]; hist: Num[] }
  | { g: "dual"; a: Num[]; b: Num[]; guides?: number[] }
  | { g: "adx"; adx: Num[]; plusDi: Num[]; minusDi: Num[]; guides?: number[] };

// The pattern engine is shared with the edge functions and expects numeric
// epoch times; only bar geometry is actually read, so the index is enough of
// a monotonic clock here.
function toPatternCandles(candles: CandleDto[]) {
  return candles.map((c, i) => ({
    time: i, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0,
  }));
}

function computeStudy(candles: CandleDto[], s: Study): Computed {
  // Clamp any user param to a safe integer (period-like) so a bad -5 doesn't
  // silently cascade into all-null output. Ratios (mult/step/pct) are clamped
  // to a small positive floor but keep decimals.
  const p: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.params)) {
    const n = Number(v);
    if (!Number.isFinite(n)) { p[k] = 1; continue; }
    if (k === "mult" || k === "step" || k === "max" || k === "pct") p[k] = Math.max(0.001, n);
    // Flags/percentages may legitimately be 0 — don't floor them up to 1.
    else if (k === "resetDaily" || k === "side" || k === "showBull" || k === "showBear" || k === "showNeutral") p[k] = n >= 0.5 ? 1 : 0;
    else p[k] = Math.max(1, Math.floor(n));
  }
  const src = () => sourceValues(candles, s.source ?? "close");
  switch (s.type) {
    case "ema": return { g: "ma", line: emaV(src(), p.period) };
    case "sma": return { g: "ma", line: smaV(src(), p.period) };
    case "wma": return { g: "ma", line: wmaV(src(), p.period) };
    case "hma": return { g: "ma", line: hmaV(src(), p.period) };
    case "dema": return { g: "ma", line: demaV(src(), p.period) };
    case "tema": return { g: "ma", line: temaV(src(), p.period) };
    case "vwma": return { g: "ma", line: vwma(candles, p.period, s.source ?? "close") };
    case "vwap": return { g: "ma", line: vwap(candles) };
    case "bb": return { g: "band", ...bollingerV(src(), p.period, p.mult) };
    case "envelopes": return { g: "band", ...envelopesV(src(), p.period, p.pct) };
    case "keltner": return { g: "band", ...keltner(candles, p.emaPeriod, p.atrPeriod, p.mult) };
    case "donchian": return { g: "band", ...donchian(candles, p.period) };
    case "supertrend": return { g: "supertrend", ...supertrend(candles, p.atrPeriod, p.mult) };
    case "psar": { const r = psar(candles, p.step, p.max); return { g: "psar", sar: r.sar, dir: r.dir }; }
    case "ichimoku": return { g: "ichimoku", ...ichimoku(candles, p.conv, p.base, p.spanB), base: p.base };
    case "volume": return { g: "volume" };
    // Pattern studies run the same detection engine the backend scores with,
    // just evaluated at every bar instead of only the last one.
    case "candlePatterns": {
      const detail = detailFromParam(p.detail);
      const { marks } = detectPatternSeries(toPatternCandles(candles), { minBars: candles.length + 1 });
      const keep = marks.filter((m) =>
        tierAllows(m.key, detail) && (
          (m.tone === "bullish" && p.showBull === 1) ||
          (m.tone === "bearish" && p.showBear === 1) ||
          (m.tone === "neutral" && p.showNeutral === 1)));
      const cap = Math.max(5, p.maxMarks ?? 40);
      return { g: "patterns", marks: keep.length > cap ? keep.slice(-cap) : keep };
    }
    case "chartPatterns": {
      const detail = detailFromParam(p.detail);
      const { shapes } = detectPatternSeries(toPatternCandles(candles), { maxShapes: Math.max(1, p.maxShapes ?? 6) });
      const keep = shapes.filter((sh) =>
        tierAllows(sh.key, detail) && (
          (sh.tone === "bullish" && p.showBull === 1) ||
          (sh.tone === "bearish" && p.showBear === 1) ||
          (sh.tone === "neutral" && p.showNeutral === 1)));
      return { g: "shapes", shapes: keep };
    }

    case "rsi": return { g: "single", line: rsi(candles, p.period), guides: [70, 30] };
    case "macd": { const m = macd(candles, p.fast, p.slow, p.signal); return { g: "macd", macd: m.macd, signal: m.signal, hist: m.hist }; }
    case "stoch": { const st = stochastic(candles, p.k, p.d, p.smooth); return { g: "dual", a: st.k, b: st.d, guides: [80, 20] }; }
    case "stochRsi": { const st = stochRsi(candles, p.rsiPeriod, p.stochPeriod, p.k, p.d); return { g: "dual", a: st.k, b: st.d, guides: [80, 20] }; }
    case "adx": { const a = adx(candles, p.period); return { g: "adx", adx: a.adx, plusDi: a.plusDi, minusDi: a.minusDi, guides: [25] }; }
    case "atr": return { g: "single", line: atr(candles, p.period) };
    case "cci": return { g: "single", line: cci(candles, p.period), guides: [100, -100] };
    case "williamsR": return { g: "single", line: williamsR(candles, p.period), guides: [-20, -80] };
    case "roc": return { g: "single", line: roc(candles, p.period), guides: [0] };
    case "mom": return { g: "single", line: mom(candles, p.period), guides: [0] };
    case "trix": return { g: "single", line: trix(candles, p.period), guides: [0] };
    case "uo": return { g: "single", line: uo(candles, p.p1, p.p2, p.p3), guides: [70, 30] };
    case "cmf": return { g: "single", line: cmf(candles, p.period), guides: [0] };
    case "ad": return { g: "single", line: ad(candles) };
    case "chaikinOsc": return { g: "single", line: chaikinOsc(candles, p.fast, p.slow), guides: [0] };
    case "aroon": { const a = aroon(candles, p.period); return { g: "dual", a: a.up, b: a.down, guides: [50] }; }
    case "vortex": { const v = vortex(candles, p.period); return { g: "dual", a: v.plus, b: v.minus }; }
    case "stddev": return { g: "single", line: stddevV(src(), p.period) };
    case "obv": {
      const r = obvWithMa(candles, p.maPeriod ?? 20, p.resetDaily === 1);
      return { g: "obv", line: r.obv, ma: r.ma };
    }
    case "volumeProfile": return {
      g: "vprofile",
      rows: p.rows ?? 24,
      valueAreaPct: p.valueArea ?? 70,
      widthPct: p.widthPct ?? 25,
      rightSide: p.side !== 0,
    };
    case "mfi": return { g: "single", line: mfi(candles, p.period), guides: [80, 20] };
    case "ao": return { g: "single", line: ao(candles, p.fast, p.slow), guides: [0], hist: true };
    default: return { g: "single", line: new Array(candles.length).fill(null) };
  }
}

// primary series for the legend value
function primaryOf(c: Computed): Num[] | null {
  switch (c.g) {
    case "ma": return c.line;
    case "band": return c.mid;
    case "supertrend": return c.line;
    case "psar": return c.sar;
    case "ichimoku": return c.tenkan;
    case "single": return c.line;
    case "obv": return c.line;
    case "macd": return c.macd;
    case "dual": return c.a;
    case "adx": return c.adx;
    default: return null;
  }
}

export interface CandleChartSettings {
  grid: boolean;
  logScale: boolean;
  priceLine: boolean;
  sessionBreaks: boolean;
  magnet?: boolean;
}


export function CandleChart({
  candles,
  priceLines,
  height = 420,
  fill = false,
  chartType = "candles",
  studies,
  intraday = false,
  livePrice = null,
  liveVolume = null,
  settings,
  onToggleStudy,
  onEditStudy,
  onRemoveStudy,
  source,
  visibleBars = null,
  viewportKey,
  paneResetToken = 0,
  focusRange = null,
  onPatternPick,
}: {
  candles: CandleDto[];
  priceLines?: Array<{ price: number; label: string; color: string }>;
  height?: number;
  fill?: boolean;
  chartType?: ChartType;
  studies: Study[];
  intraday?: boolean;
  /** Live LTP for the symbol on screen — moves/extends the rightmost bar in
   * real time via `series.update()` (no full chart rebuild) between the
   * periodic historical refetches that eventually supersede it. */
  livePrice?: number | null;
  /** Live cumulative session volume for the current bar (updates the volume pane). */
  liveVolume?: number | null;
  /** Display toggles (grid/log/priceLine/sessionBreaks). */
  settings?: CandleChartSettings;
  onToggleStudy?: (id: string) => void;
  onEditStudy?: (id: string) => void;
  onRemoveStudy?: (id: string) => void;
  /** Primary data provider that served the candles. */
  source?: "kotak_neo" | "yahoo" | "cache" | "quote" | "quote_delayed" | "none" | null;
  /** Initial visible window in bars (newest-first). `null` fits the whole
   * series. The full series stays loaded either way — this only sets the
   * viewport, so scrolling left still reveals the older history. */
  visibleBars?: number | null;
  /** Identity of the opened chart. A new identity discards any zoom/range
   * captured from the previous symbol or timeframe. */
  viewportKey?: string;
  /** Bump to clear user-dragged sub-pane heights and re-apply the auto split. */
  paneResetToken?: number;
  focusRange?: { startIndex: number; endIndex: number; token: number } | null;
  /** Fired when a pattern marker on the chart is clicked. */
  onPatternPick?: (sel: { kind: "candle"; result: CandleMark } | { kind: "shape"; result: ChartShape }) => void;
}) {


  const marketOpen = useMarketOpen();
  const ref = useRef<HTMLDivElement>(null);
  const printedVolRef = useRef<{ key: string; value: number } | null>(null);


  const chartRef = useRef<IChartApi | null>(null);
  const [legend, setLegend] = useState<CandleDto | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // Viewport preservation. Absolute logical indices are useless across data
  // refreshes: appending a bar (and trimming the oldest one on a rolling
  // intraday window) shifts every index, which used to drag the view
  // backwards in time until the chart showed stale candles. We store the view
  // ANCHORED TO THE NEWEST BAR instead — span plus distance from the right
  // edge — which is what TradingView effectively does.
  const viewAnchorRef = useRef<{ span: number; barsFromEnd: number } | null>(null);
  const dataLenRef = useRef(0);
  // While the viewport sits at the real-time edge we keep following new bars;
  // once the user scrolls back we hold their range exactly.
  const followLiveRef = useRef(true);
  const [atLiveEdge, setAtLiveEdge] = useState(true);
  const identityRef = useRef<string | null>(null);
  const userInteractedRef = useRef(false);
  const programmaticRangeRef = useRef(false);
  // Gesture guard: while the user is actively wheeling/dragging the chart we
  // never rebuild it — a rebuild landing mid-gesture is exactly what made
  // zooming "snap back". The idle window is generous (1.2s) so a slow drag or
  // a stuttering wheel flick never reads as "user finished".
  const pointerDownRef = useRef(false);
  const lastInteractRef = useRef(0);
  const IDLE_MS = 1200;
  const isInteractingRef = useRef(() => pointerDownRef.current || Date.now() - lastInteractRef.current < IDLE_MS);
  const isInteracting = () => isInteractingRef.current();



  // live-tick plumbing: refs so the 1s price update never tears down the chart
  const priceSeriesRef = useRef<ISeriesApi<any> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<any> | null>(null);
  const liveBarRef = useRef<{ seriesTime: any; rawTime: string | number; open: number; high: number; low: number; close: number; volume: number } | null>(null);
  // Median inter-bar gap (seconds) captured at last render; used by the live
  // tick effect to detect when wall-clock has crossed a bar boundary so
  // intraday charts roll to a fresh bar instead of stretching one monster bar.
  const medianGapRef = useRef<number>(0);
  const [liveBar, setLiveBar] = useState<CandleDto | null>(null);
  // Volume Profile readout for the legend (visible-range POC + buy/sell split).
  const [vpStats, setVpStats] = useState<{ poc: number | null; upVol: number; downVol: number } | null>(null);
  // Lets the live tick extend OBV's last point without rebuilding the chart.
  const obvLiveRef = useRef<{ series: ISeriesApi<any>; accBefore: number; prevClose: number } | null>(null);
  // Sub-pane heights the user dragged, keyed by the pane set signature so a
  // data refresh (which rebuilds the chart) replays them instead of resetting.
  const paneHeightsRef = useRef<{ sig: string; heights: number[] } | null>(null);
  const paneSigRef = useRef<string>("");
  const paneStoreKey = `mk.chart.panes.${viewportKey ?? "default"}`;
  const paneStoreKeyRef = useRef(paneStoreKey);
  // Everything the pattern studies drew this render, so a chart click can be
  // resolved back to the exact detection that produced the marker.
  const patternHitsRef = useRef<{ marks: CandleMark[]; shapes: ChartShape[] }>({ marks: [], shapes: [] });
  const onPatternPickRef = useRef(onPatternPick);
  onPatternPickRef.current = onPatternPick;
  const s = settings ?? { grid: true, logScale: false, priceLine: true, sessionBreaks: false, magnet: false };
  // Deconstructed so effect dep can be primitive and stable across parent
  // renders when the settings object identity changes but values don't.
  const { grid: sGrid, logScale: sLog, priceLine: sPriceLine, sessionBreaks: sSessionBreaks, magnet: sMagnet } = s;

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !focusRange) return;
    const span = Math.max(3, focusRange.endIndex - focusRange.startIndex + 1);
    const pad = Math.max(2, Math.ceil(span * 0.15));
    const from = focusRange.startIndex - pad;
    const to = focusRange.endIndex + pad;
    chart.timeScale().setVisibleLogicalRange({ from, to });
    // Jumping to a pattern is an explicit navigation: stop following the live
    // edge and remember the range anchored to the newest bar.
    followLiveRef.current = false;
    setAtLiveEdge(false);
    userInteractedRef.current = true;
    viewAnchorRef.current = { span: to - from, barsFromEnd: Math.max(0, dataLenRef.current - 1 - to) };

  }, [focusRange]);



  // Memoize per-study compute keyed by (candles reference, study JSON) so
  // toggling one study's param doesn't recompute every other study.
  // lightweight-charts silently renders nothing when times are out of order or
  // duplicated. Normalise every time to a numeric epoch (seconds) before
  // sorting/deduping so ISO ↔ number mismatches from refresh races don't slip
  // through — and so indicators and bars share one index space.
  const cleanCandles = useMemo(() => {
    const epoch = (t: string | number): number => {
      if (typeof t === "number") return t;
      const parsed = Date.parse(t);
      return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
    };
    const sorted = [...candles].sort((a, b) => epoch(a.time) - epoch(b.time));
    const seen = new Set<number>();
    const cleaned = sorted.filter((c) => {
      const k = epoch(c.time);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // Surface upstream cache bugs — silently dropping duplicates hides them.
    if (import.meta.env?.DEV && cleaned.length !== candles.length) {
      // eslint-disable-next-line no-console
      console.warn(`[CandleChart] dropped ${candles.length - cleaned.length} duplicate/out-of-order bars`);
    }
    return cleaned.length === candles.length ? candles : cleaned;
  }, [candles]);

  const studyCache = useRef<WeakMap<CandleDto[], Map<string, Computed>>>(new WeakMap());
  const computed = useMemo(() => {
    let bucket = studyCache.current.get(cleanCandles);
    if (!bucket) { bucket = new Map(); studyCache.current.set(cleanCandles, bucket); }
    return studies.map((st) => {
      const key = `${st.type}|${st.source ?? "close"}|${JSON.stringify(st.params)}`;
      let data = bucket!.get(key);
      if (!data) { data = computeStudy(cleanCandles, st); bucket!.set(key, data); }
      return { study: st, data };
    });
  }, [cleanCandles, studies]);

  // ---- rebuild gate -------------------------------------------------------
  // The chart used to be destroyed and recreated on every candle poll (the
  // render effect depended on the candle array), which threw the zoom/pan
  // state away several times a minute and made the live edge jitter. Rebuild
  // only when the bar STRUCTURE changes (new/removed bars, new studies); when
  // a poll merely revalues the forming bar, update that bar in place.
  const candlesRef = useRef(cleanCandles);
  const computedRef = useRef(computed);
  const studiesSig = useMemo(() => JSON.stringify(studies), [studies]);
  const structKeyRef = useRef<string>("");
  const [renderTick, setRenderTick] = useState(0);
  // Bumped to re-evaluate a deferred structural rebuild once the user stops
  // interacting with the chart.
  const [deferTick, setDeferTick] = useState(0);
  useEffect(() => {
    candlesRef.current = cleanCandles;
    computedRef.current = computed;
    const lastC = cleanCandles[cleanCandles.length - 1];
    const key = `${cleanCandles.length}|${cleanCandles[0]?.time ?? ""}|${lastC?.time ?? ""}|${studiesSig}`;
    let deferTimer: number | undefined;
    if (key !== structKeyRef.current) {
      // Never tear the chart down while a zoom/pan gesture is in flight —
      // retry once the user has actually stopped working the chart. The last
      // bar is still pushed in place below (LWC `update` appends when the time
      // is newer), so the live edge keeps moving without a rebuild.
      if (structKeyRef.current && isInteracting()) {
        deferTimer = window.setTimeout(() => setDeferTick((d) => d + 1), 500);
      } else {
        structKeyRef.current = key;
        setRenderTick((t) => t + 1);
        return;
      }
    }
    const series = priceSeriesRef.current;
    if (!series || !lastC) return () => { if (deferTimer) window.clearTimeout(deferTimer); };
    const t = lastC.time as any;
    try {
      if (chartType === "line" || chartType === "area" || chartType === "baseline") {
        series.update({ time: t, value: lastC.close });
      } else if (chartType !== "heikin_ashi") {
        series.update({ time: t, open: lastC.open, high: lastC.high, low: lastC.low, close: lastC.close });
      }
      liveBarRef.current = {
        seriesTime: t, rawTime: lastC.time,
        open: lastC.open, high: lastC.high, low: lastC.low, close: lastC.close, volume: lastC.volume,
      };
      setLiveBar(null);
    } catch { /* the next structural rebuild will resync */ }
    return () => { if (deferTimer) window.clearTimeout(deferTimer); };
  }, [cleanCandles, computed, studiesSig, chartType, deferTick]);


  // Track pointer/wheel activity on the chart container so the gesture guard
  // above (and the programmatic range application) knows when to stand down.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mark = () => { lastInteractRef.current = Date.now(); };
    const down = () => { pointerDownRef.current = true; mark(); };
    const up = () => { pointerDownRef.current = false; mark(); };
    const move = () => { if (pointerDownRef.current) mark(); };
    el.addEventListener("pointerdown", down, { capture: true });
    window.addEventListener("pointerup", up, { capture: true });
    window.addEventListener("pointercancel", up, { capture: true });
    window.addEventListener("pointermove", move, { capture: true, passive: true });
    el.addEventListener("wheel", mark, { capture: true, passive: true });
    el.addEventListener("touchmove", mark, { capture: true, passive: true });
    return () => {
      el.removeEventListener("pointerdown", down, { capture: true } as any);
      window.removeEventListener("pointerup", up, { capture: true } as any);
      window.removeEventListener("pointercancel", up, { capture: true } as any);
      window.removeEventListener("pointermove", move, { capture: true } as any);
      el.removeEventListener("wheel", mark, { capture: true } as any);
      el.removeEventListener("touchmove", mark, { capture: true } as any);
    };
  }, []);






  // Restore persisted pane heights when the opened chart identity changes,
  // and drop them when the parent asks for a reset.
  useEffect(() => {
    paneStoreKeyRef.current = paneStoreKey;
    paneHeightsRef.current = safeStorage.getJSON<{ sig: string; heights: number[] } | null>(paneStoreKey, null);
  }, [paneStoreKey]);

  useEffect(() => {
    if (!paneResetToken) return;
    paneHeightsRef.current = null;
    safeStorage.remove(paneStoreKeyRef.current);
  }, [paneResetToken]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Studies are computed over the SAME cleaned/sorted series the chart draws
    // (see `cleanCandles`) — plotting is positional, so using the raw prop here
    // shifted every indicator by one bar whenever a duplicate was dropped.
    const data = candlesRef.current;
    const computedNow = computedRef.current;


    // NSE session is 09:15–15:30 IST. Lightweight-charts defaults to UTC, so
    // without an IST formatter the market opens at "03:45" on every chart.
    // Format epoch seconds through Asia/Kolkata for both axis ticks and the
    // crosshair label; underlying data stays in UTC.
    const istTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const istDate = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "2-digit",
    });
    const istDayMonth = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
    });
    const istMonthYear = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata", month: "short", year: "2-digit",
    });
    const istDateTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    // IST day-key ("YYYY-MM-DD") for detecting session boundaries on the axis.
    const istDayKey = (d: Date) => {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(d);
      const y = parts.find((p) => p.type === "year")?.value ?? "";
      const m = parts.find((p) => p.type === "month")?.value ?? "";
      const dd = parts.find((p) => p.type === "day")?.value ?? "";
      return `${y}-${m}-${dd}`;
    };
    // Detect intraday: caller-supplied prop is the source of truth (known at
    // fetch time). Median-gap detection is a fallback for legacy callers that
    // don't pass `intraday` — it's fragile at market open when only 1–2 bars
    // exist for the day.
    // Detect intraday: caller-supplied prop is the source of truth (known at
    // fetch time). Median-gap detection is the fallback for legacy callers.
    // Gaps larger than a day (overnight/weekend breaks) are excluded so an
    // early session boundary can't push the median past 86400 and mis-flag an
    // intraday series as daily/monthly.
    const _nums = data.map((c) => c.time).filter((t): t is number => typeof t === "number");
    const _allGaps = _nums.slice(1).map((t, i) => t - _nums[i]).filter((g) => g > 0);
    const _intraGaps = _allGaps.filter((g) => g < 86_400).sort((a, b) => a - b);
    const _dayGaps = _allGaps.filter((g) => g >= 86_400).sort((a, b) => a - b);
    const _median = (arr: number[]) => (arr.length ? arr[Math.floor(arr.length / 2)] : 0);
    // Intraday interval when we have same-day gaps; otherwise the daily+ step.
    const _medianGap = _intraGaps.length >= Math.max(2, _allGaps.length * 0.5)
      ? _median(_intraGaps)
      : (_intraGaps.length && _dayGaps.length === 0 ? _median(_intraGaps) : _median(_dayGaps));
    medianGapRef.current = _medianGap > 0 ? _medianGap : _median(_intraGaps);
    const isIntraday = intraday || _intraGaps.length > _dayGaps.length;
    const isMonthly = !isIntraday && _median(_dayGaps) >= 86_400 * 27;
    // Log-scale safety: LWC's logarithmic price mode blows up on values <= 0
    // (VIX-like series with a 0 print, or overlays). Force Normal when any
    // low is non-positive so the whole chart doesn't disappear silently.
    const hasNonPositivePrice = data.some((c) => c.low <= 0 || c.close <= 0);
    const useLog = sLog && !hasNonPositivePrice;
    if (sLog && hasNonPositivePrice && import.meta.env?.DEV) {
      // eslint-disable-next-line no-console
      console.warn("[CandleChart] log scale disabled — series contains value <= 0");
    }
    // The axis formatter MUST be stateless: lightweight-charts calls
    // tickMarkFormatter repeatedly, out of order, and for candidate marks it
    // later discards — so a "did the day change since the last call?" closure
    // printed the same date twice (e.g. "30 Jul" appearing on two ticks) and
    // dropped it on real session starts. Instead we use the library's
    // tickMarkType plus a precomputed set of session-opening bar times.
    const sessionFirstBar = new Set<number>();
    if (isIntraday) {
      let seenDay = "";
      for (const c of data) {
        if (typeof c.time !== "number") continue;
        const k = istDayKey(new Date(c.time * 1000));
        if (k !== seenDay) { seenDay = k; sessionFirstBar.add(c.time); }
      }
    }
    const fmtAxis = (t: any, tickMarkType?: TickMarkType) => {
      if (typeof t !== "number") return String(t);
      const d = new Date(t * 1000);
      if (isMonthly) return istMonthYear.format(d);
      if (!isIntraday) {
        // Daily bars: DD Mon, with the year appended on the first tick of a year.
        return tickMarkType === TickMarkType.Year ? istDate.format(d) : istDayMonth.format(d);
      }
      // Intraday: date on a session opening bar / day-or-coarser tick, else HH:mm.
      const isDayTick =
        tickMarkType === TickMarkType.Year ||
        tickMarkType === TickMarkType.Month ||
        tickMarkType === TickMarkType.DayOfMonth;
      return isDayTick || sessionFirstBar.has(t) ? istDayMonth.format(d) : istTime.format(d);
    };

    const fmtCrosshair = (t: any) => {
      if (typeof t !== "number") return String(t);
      const d = new Date(t * 1000);
      return isIntraday ? istDateTime.format(d) : istDate.format(d);
    };


    const chart = createChart(el, {
      height: fill ? el.clientHeight || height : height,
      width: el.clientWidth || 600,
      layout: {
        background: { color: "transparent" },
        textColor: "#6a93a8",
        fontFamily: "system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: false,
        panes: { separatorColor: "rgba(53,214,237,0.15)", separatorHoverColor: "rgba(53,214,237,0.35)", enableResize: true },
      },
      localization: {
        timeFormatter: fmtCrosshair,
      },
      grid: {
        vertLines: { color: "rgba(53,214,237,0.06)", visible: sGrid },
        horzLines: { color: "rgba(53,214,237,0.06)", visible: sGrid },
      },
      rightPriceScale: {
        borderColor: "rgba(53,214,237,0.15)",
        mode: useLog ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
      },
      timeScale: {
        borderColor: "rgba(53,214,237,0.15)",
        // Time-of-day on the axis only for intraday grains — daily bars
        // delivered as epoch numbers were rendering "09:15"-style ticks.
        timeVisible: isIntraday,
        secondsVisible: false,
        tickMarkFormatter: fmtAxis,
        // TradingView leaves air to the right of the last bar and lets you
        // scroll freely into that whitespace. Pinning BOTH edges (fixLeftEdge +
        // fixRightEdge) clamps the logical range so hard that the newest candle
        // is welded to the right border and panning snaps straight back — which
        // is exactly the "can't move the chart" behaviour. Leave both edges
        // free, like every real trading terminal.
        rightOffset: RIGHT_AIR,
        fixLeftEdge: false,
        fixRightEdge: false,
        // Zoom-out floor: minute series with thousands of bars used to clip
        // instead of compressing.
        minBarSpacing: 0.12,

        // New bars scroll the view only while it's parked at the live edge —
        // LWC honours the user's scrollback otherwise.
        shiftVisibleRangeOnNewBar: true,
        allowShiftVisibleRangeOnWhitespaceReplacement: true,
        // Resizing the window or dragging a pane divider must not re-frame.
        lockVisibleTimeRangeOnResize: true,
      },
      // TradingView contract: wheel/pinch zoom time, axis drag scales its own
      // axis, double-click an axis resets it, kinetic scroll on touch only.
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      kineticScroll: { touch: true, mouse: false },

      crosshair: {
        // Normal = free-floating crosshair: the horizontal line and its price
        // label follow the exact cursor y instead of snapping to the hovered
        // bar's nearest OHLC value (LWC's default Magnet behaviour, which made
        // hovering a candle's body read back its close). TradingView ships the
        // free crosshair by default and exposes magnet as an opt-in mode.
        mode: sMagnet ? CrosshairMode.Magnet : CrosshairMode.Normal,
        vertLine: { color: "rgba(53,214,237,0.4)", labelBackgroundColor: "#0a2733" },
        horzLine: { color: "rgba(53,214,237,0.4)", labelBackgroundColor: "#0a2733" },
      },

    });
    chartRef.current = chart;


    const toTime = (t: string | number) => (typeof t === "number" ? (t as UTCTimestamp) : t) as any;
    const timeKey = (t: any): string => {
      if (typeof t === "number" || typeof t === "string") return String(t);
      if (t && typeof t === "object" && "year" in t && "month" in t && "day" in t) {
        return `${String(t.year).padStart(4, "0")}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
      }
      return String(t ?? "");
    };
    const lw = (n: number) => Math.max(1, Math.min(4, Math.round(n))) as 1 | 2 | 3 | 4;
    const lineData = (values: Num[], offset = 0) =>
      data.flatMap((c, i) => {
        const vi = i - offset;
        return vi >= 0 && values[vi] != null ? [{ time: toTime(c.time), value: values[vi] as number }] : [];
      });

    // ---- price series (pane 0) ----
    const tk = readTokens();
    let priceSeries: ISeriesApi<any>;
    // Heikin-Ashi: smoothed candles computed from raw OHLC. Uses the same
    // CandlestickSeries — only the input values change. The live-tick effect
    // still updates the raw last bar; the HA transform is a display-only
    // aggregation, so during a live session the last HA bar drifts slightly
    // until the next full refetch. Acceptable tradeoff — TV behaves the same.
    let displayData = data;
    if (chartType === "heikin_ashi") {
      const ha: typeof data = [];
      for (let i = 0; i < data.length; i++) {
        const c = data[i];
        const close = (c.open + c.high + c.low + c.close) / 4;
        const open = i === 0
          ? (c.open + c.close) / 2
          : (ha[i - 1].open + ha[i - 1].close) / 2;
        const high = Math.max(c.high, open, close);
        const low = Math.min(c.low, open, close);
        ha.push({ ...c, open, high, low, close });
      }
      displayData = ha;
    }
    if (chartType === "bars") {
      priceSeries = chart.addSeries(BarSeries, { upColor: tk.up, downColor: tk.down, thinBars: false });
      priceSeries.setData(displayData.map((c) => ({ time: toTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    } else if (chartType === "line") {
      // Line/area plot a single value per bar, so a crosshair marker dot on the
      // series is the industry-standard readout (candles/bars don't use one).
      priceSeries = chart.addSeries(LineSeries, {
        color: "#35d6ed", lineWidth: 2,
        crosshairMarkerVisible: true, crosshairMarkerRadius: 3,
        crosshairMarkerBorderColor: "#35d6ed", crosshairMarkerBackgroundColor: "#041016",
      });
      priceSeries.setData(displayData.map((c) => ({ time: toTime(c.time), value: c.close })));
    } else if (chartType === "area") {
      priceSeries = chart.addSeries(AreaSeries, {
        lineColor: "#35d6ed", lineWidth: 2, topColor: "rgba(53,214,237,0.25)", bottomColor: "rgba(53,214,237,0.02)",
        crosshairMarkerVisible: true, crosshairMarkerRadius: 3,
        crosshairMarkerBorderColor: "#35d6ed", crosshairMarkerBackgroundColor: "#041016",
      });
      priceSeries.setData(displayData.map((c) => ({ time: toTime(c.time), value: c.close })));

    } else if (chartType === "baseline") {
      // Baseline: split colouring above/below the series' own midpoint. TV/Kite
      // both offer this as a "trend visualiser". Base value defaults to the
      // mid of visible range — same behaviour as lightweight-charts default.
      priceSeries = chart.addSeries(BaselineSeries, {
        topLineColor: tk.up, topFillColor1: tk.upFill, topFillColor2: "rgba(107,255,176,0.02)",
        bottomLineColor: tk.down, bottomFillColor1: tk.downFill, bottomFillColor2: "rgba(255,95,109,0.02)",
        lineWidth: 2,
        crosshairMarkerVisible: true, crosshairMarkerRadius: 3,
      });
      priceSeries.setData(displayData.map((c) => ({ time: toTime(c.time), value: c.close })));
    } else {
      // "candles" and "heikin_ashi" — same series, different input data.
      priceSeries = chart.addSeries(CandlestickSeries, {
        upColor: tk.up, downColor: tk.down, borderUpColor: tk.up, borderDownColor: tk.down,
        wickUpColor: tk.upFill, wickDownColor: tk.downFill,
      });
      priceSeries.setData(displayData.map((c) => ({ time: toTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    }
    priceSeries.applyOptions({ priceLineVisible: sPriceLine, lastValueVisible: sPriceLine });
    priceSeriesRef.current = priceSeries;
    const lastRaw = data[data.length - 1];
    liveBarRef.current = lastRaw
      ? { seriesTime: toTime(lastRaw.time), rawTime: lastRaw.time, open: lastRaw.open, high: lastRaw.high, low: lastRaw.low, close: lastRaw.close, volume: lastRaw.volume }
      : null;
    setLiveBar(null);
    volumeSeriesRef.current = null;


    const overlayLine = (values: Num[], color: string, width = 1, style?: LineStyle, lastVal = false, offset = 0) => {
      const line = chart.addSeries(LineSeries, {
        color, lineWidth: lw(width), lineStyle: style,
        priceLineVisible: false, lastValueVisible: lastVal, crosshairMarkerVisible: false,
      });
      line.setData(lineData(values, offset));
    };

    // ---- overlays (visible, price pane) ----
    // Collected so multiple Supertrend studies don't leak plugins on cleanup.
    const markersPlugins: ISeriesMarkersPluginApi<any>[] = [];
    // Shared label budget for candle marks *and* structure chips, so the two
    // studies can never stack text on the same bars. `claimLabel` also guards
    // the right margin: labels near the last bar get clipped by the price
    // scale, so they degrade to an unlabelled marker.
    const labelClaims: number[] = [];
    const claimLabel = (index: number, minGap: number, barCount: number) => {
      if (index > barCount - 3 || index < 3) return false;
      if (labelClaims.some((x) => Math.abs(x - index) < minGap)) return false;
      labelClaims.push(index);
      return true;
    };
    const primitives: VolumeProfilePrimitive[] = [];
    patternHitsRef.current = { marks: [], shapes: [] };

    for (const { study, data: c } of computedNow) {
      if (!study.visible) continue;
      const def = defByType(study.type);
      if (def.group !== "overlay") continue;
      // VWAP is intraday-only (session-anchored); on daily+ TFs it collapses to
      // the typical price and is misleading. Industry-standard: hide it.
      if (study.type === "vwap" && !intraday) continue;
      const col = study.colors;
      const w = study.lineWidth;
      if (c.g === "ma") {
        overlayLine(c.line, col[0], w, undefined, true);
      } else if (c.g === "band") {
        overlayLine(c.upper, col[0], w);
        overlayLine(c.mid, col[1], w, LineStyle.Dashed);
        overlayLine(c.lower, col[2], w);
      } else if (c.g === "supertrend") {
        const upColor = col[0] ?? UP;
        const dnColor = col[1] ?? DOWN;
        // Emit contiguous segments per trend direction. At each flip we push
        // a `null` whitespace point on the *newly-inactive* side so
        // lightweight-charts breaks the line cleanly instead of visually
        // jumping across the flip Y-gap.
        // Whitespace points in lightweight-charts are `{ time }` with NO
        // `value` key (null is rejected by the line-series assertion).
        const upData: Array<{ time: any; value?: number }> = [];
        const dnData: Array<{ time: any; value?: number }> = [];
        for (let i = 0; i < data.length; i++) {
          const v = c.line[i];
          const d = c.dir[i];
          const t = toTime(data[i].time);
          if (v == null || d == null) continue;
          const prevDir = i > 0 ? c.dir[i - 1] : null;
          const flipped = prevDir != null && prevDir !== d;
          const tPrev = i > 0 ? toTime(data[i - 1].time) : t;
          if (d === 1) {
            if (flipped) {
              dnData.push({ time: t });
              if (upData.length) upData.push({ time: tPrev });
            }
            upData.push({ time: t, value: v as number });
          } else {
            if (flipped) {
              upData.push({ time: t });
              if (dnData.length) dnData.push({ time: tPrev });
            }
            dnData.push({ time: t, value: v as number });
          }
        }
        const upS = chart.addSeries(LineSeries, { color: upColor, lineWidth: lw(w), priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
        upS.setData(upData as any);
        const dnS = chart.addSeries(LineSeries, { color: dnColor, lineWidth: lw(w), priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
        dnS.setData(dnData as any);
        // Flip markers on the price series — triangles at direction changes.
        // lightweight-charts v5 removed series.setMarkers; use the plugin API.
        try {
          const markers: Array<{ time: any; position: "belowBar" | "aboveBar"; color: string; shape: "arrowUp" | "arrowDown"; text?: string }> = [];
          for (let i = 1; i < data.length; i++) {
            const prev = c.dir[i - 1], cur = c.dir[i];
            if (prev == null || cur == null || prev === cur) continue;
            if (cur === 1) markers.push({ time: toTime(data[i].time), position: "belowBar", color: upColor, shape: "arrowUp", text: "Buy" });
            else markers.push({ time: toTime(data[i].time), position: "aboveBar", color: dnColor, shape: "arrowDown", text: "Sell" });
          }
          if (markers.length) {
            markersPlugins.push(createSeriesMarkers(priceSeries, markers as any));
          }
        } catch { /* markers optional */ }
      } else if (c.g === "vprofile") {
        // Visible-range volume profile, painted in the price pane. Rows are
        // split into buying vs selling volume so the balance at each price
        // level is readable directly off the chart.
        const vp = new VolumeProfilePrimitive(
          data,
          {
            rows: c.rows, valueAreaPct: c.valueAreaPct, widthPct: c.widthPct, rightSide: c.rightSide,
            upColor: col[0] ?? tk.up, downColor: col[1] ?? tk.down, pocColor: col[2] ?? tk.neutral,
          },
          (res) => setVpStats({ poc: res.poc, upVol: res.upVol, downVol: res.downVol }),
        );
        (priceSeries as any).attachPrimitive(vp);
        primitives.push(vp);
      } else if (c.g === "psar") {
        // Colour each dot by the algorithm's trend direction (industry
        // standard) — green in uptrends, red in downtrends.
        const upData: Array<{ time: any; value: number }> = [];
        const dnData: Array<{ time: any; value: number }> = [];
        for (let i = 0; i < data.length; i++) {
          const v = c.sar[i];
          const d = c.dir[i];
          if (v == null || d == null) continue;
          if (d === 1) upData.push({ time: toTime(data[i].time), value: v as number });
          else dnData.push({ time: toTime(data[i].time), value: v as number });
        }
        const mk = (color: string, rows: any[]) => {
          const line = chart.addSeries(LineSeries, {
            color, lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 3,
            priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          });
          line.setData(rows);
        };
        mk(col[0] ?? UP, upData);
        mk(DOWN, dnData);
      } else if (c.g === "ichimoku") {
        overlayLine(c.tenkan, col[0], w);
        overlayLine(c.kijun, col[1], w);
        // Senkou spans are projected `base` bars ahead of the last bar
        // (TradingView convention). Compute an average bar interval from the
        // last several bars, then append synthetic future timestamps so the
        // cloud renders beyond the current price action instead of getting
        // truncated at the right edge.
        const projectSpan = (values: Num[], color: string) => {
          const rows: Array<{ time: any; value: number }> = [];
          // Historical portion — align spans back onto their computed bars.
          for (let i = 0; i < data.length; i++) {
            const v = values[i];
            if (v == null) continue;
            rows.push({ time: toTime(data[i].time), value: v as number });
          }
          // Future projection: last `base` valid values shifted forward.
          const lastN = Math.min(c.base, data.length - 1);
          if (lastN > 0) {
            // Estimate bar spacing (numeric epoch seconds).
            const asSec = (t: string | number) => (typeof t === "number" ? t : Math.floor(Date.parse(t as string) / 1000));
            const spans: number[] = [];
            for (let i = data.length - Math.min(20, data.length) + 1; i < data.length; i++) {
              const dt = asSec(data[i].time) - asSec(data[i - 1].time);
              if (Number.isFinite(dt) && dt > 0) spans.push(dt);
            }
            const step = spans.length ? spans.sort((a, b) => a - b)[Math.floor(spans.length / 2)] : 86400;
            const lastT = asSec(data[data.length - 1].time);
            for (let k = 1; k <= c.base; k++) {
              const srcIdx = data.length - c.base + k - 1;
              const v = values[srcIdx];
              if (srcIdx < 0 || v == null) continue;
              rows.push({ time: (lastT + step * k) as any, value: v as number });
            }
          }
          const line = chart.addSeries(LineSeries, {
            color, lineWidth: lw(w), lineStyle: LineStyle.Dashed,
            priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          });
          line.setData(rows);
        };
        projectSpan(c.spanA, col[2]);
        projectSpan(c.spanB, col[3]);
      } else if (c.g === "patterns") {
        // Legibility first: only `key`-tier reads earn a text label, and never
        // two labels within `minGap` bars of each other — everything else draws
        // as a small unlabelled dot that is still clickable/hoverable. This is
        // what stops the chart turning into a wall of overlapping codes.
        const bull = col[0] ?? UP, bear = col[1] ?? DOWN, neut = col[2] ?? "#ffb84d";
        const drawn = c.marks
          .filter((m) => m.index >= 0 && m.index < data.length)
          .slice()
          .sort((a, b) => a.index - b.index);
        patternHitsRef.current.marks = drawn;
        const minGap = Math.max(4, Math.ceil(data.length / 25));
        // Claim labels strongest-first so the label lands on the best read in
        // a cluster rather than whichever bar came first.
        const labelled = new Set<CandleMark>();
        for (const m of drawn.slice().sort((a, b) =>
          (tierOf(b.key) === "key" ? 1 : 0) - (tierOf(a.key) === "key" ? 1 : 0) || b.confidence - a.confidence)) {
          if (tierOf(m.key) !== "key") continue;
          if (claimLabel(m.index, minGap, data.length)) labelled.add(m);
        }
        const markers = drawn.map((m) => {
          const above = m.tone === "bearish";
          const label = labelled.has(m);
          return {
            time: toTime(data[m.index].time),
            position: above ? "aboveBar" : "belowBar",
            color: m.tone === "bullish" ? bull : above ? bear : neut,
            shape: label ? (above ? "arrowDown" : "arrowUp") : "circle",
            text: label ? m.label : "",
          };
        });
        if (markers.length) {
          try { markersPlugins.push(createSeriesMarkers(priceSeries, markers as any)); } catch { /* noop */ }
        }

      } else if (c.g === "shapes") {
        // Each structure draws its real geometry: the upper and lower bounds
        // it was measured from, the breakout / neckline level, a trigger
        // arrow where it fired, and a dashed invalidation bound. Shapes with
        // no level still draw (previously they were silently skipped).
        const bull = col[0] ?? UP, bear = col[1] ?? DOWN, neutral = col[2] ?? "#ffb84d";
        const shapeMarkers: Array<Record<string, unknown>> = [];
        patternHitsRef.current.shapes = c.shapes;
        // At most 3 structure chips, strongest first, sharing the candle label
        // budget so text never collides. Everything else keeps its geometry.
        const shapeMinGap = Math.max(6, Math.ceil(data.length / 12));
        const chipped = new Set<ChartShape>();
        const bestByKey = new Map<string, ChartShape>();
        for (const sh of c.shapes) {
          const prev = bestByKey.get(sh.key);
          if (!prev || sh.confidence > prev.confidence || (sh.confidence === prev.confidence && sh.endIndex > prev.endIndex)) {
            bestByKey.set(sh.key, sh);
          }
        }
        for (const sh of [...bestByKey.values()].sort((a, b) => b.confidence - a.confidence)) {
          if (chipped.size >= 3) break;
          const b = Math.max(0, Math.min(sh.endIndex, data.length - 1));
          if (claimLabel(b, shapeMinGap, data.length)) chipped.add(sh);
        }
        for (const sh of c.shapes) {

          const a = Math.max(0, Math.min(sh.startIndex, data.length - 1));
          const b = Math.max(0, Math.min(sh.endIndex, data.length - 1));
          if (b <= a) continue;
          const color = sh.tone === "bearish" ? bear : sh.tone === "neutral" ? neutral : bull;
          const seg = (value: number, style: LineStyle, width: number, dim = false) => {
            const line = chart.addSeries(LineSeries, {
              color: dim || !sh.triggered ? withAlpha(color, sh.triggered ? 0.5 : 0.32) : color,
              lineWidth: lw(width), lineStyle: style,
              priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
            });
            line.setData([
              { time: toTime(data[a].time), value },
              { time: toTime(data[b].time), value },
            ] as any);
          };
          // Bounds box — the range every touch/tolerance test was measured on.
          if (sh.upper != null) seg(sh.upper, LineStyle.Dotted, 1, sh.level !== sh.upper);
          if (sh.lower != null) seg(sh.lower, LineStyle.Dotted, 1, sh.level !== sh.lower);
          // Breakout / neckline level — solid once triggered.
          if (sh.level != null) seg(sh.level, sh.triggered ? LineStyle.Solid : LineStyle.Dashed, Math.max(1, w));
          // Invalidation: the opposite bound of the level.
          const invalid = sh.tone === "bearish" ? sh.upper : sh.lower;
          if (invalid != null && invalid !== sh.level) seg(invalid, LineStyle.LargeDashed, 1, true);
          shapeMarkers.push({
            time: toTime(data[b].time),
            position: sh.tone === "bearish" ? "aboveBar" : "belowBar",
            color,
            shape: sh.tone === "bearish" ? "arrowDown" : "arrowUp",
            text: chipped.has(sh) ? `${sh.label} · ${sh.status} ${sh.confidence}%` : "",
          });

          // The trigger bar gets a marker, never a bare "trigger" label — the
          // structure chip already names the pattern.
          if (sh.triggerIndex != null && sh.triggerIndex >= 0 && sh.triggerIndex < data.length) {
            shapeMarkers.push({
              time: toTime(data[sh.triggerIndex].time),
              position: sh.tone === "bearish" ? "aboveBar" : "belowBar",
              color,
              shape: sh.tone === "bearish" ? "arrowDown" : "arrowUp",
              text: "",
            });
          }
        }
        if (shapeMarkers.length) {
          try { markersPlugins.push(createSeriesMarkers(priceSeries, shapeMarkers as any)); } catch { /* noop */ }
        }
      }

      // volume handled below in its own pane so it gets a proper K/M axis
    }

    // Support/resistance lines are drawn by their own effect (they change with
    // every live quote and must never rebuild the chart).


    // ---- oscillators + volume (visible, one sub-pane each) ----
    let pane = 1;
    const paneLine = (values: Num[], color: string, p: number, width = 1) => {
      const s = chart.addSeries(LineSeries, { color, lineWidth: lw(width), priceLineVisible: false, lastValueVisible: true }, p);
      s.setData(lineData(values));
      return s;
    };
    const guide = (s: ISeriesApi<any>, price: number) =>
      s.createPriceLine({ price, color: "rgba(127,233,255,0.28)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });

    // Volume gets its own sub-pane so it renders a proper K / M axis on the right.
    // Always render the volume pane UNLESS the user has an explicit hidden
    // `volume` study (opt-out, not opt-in) — this keeps volume visible after
    // TF changes, indicator resets, or on old saved states that never had a
    // volume study added. Industry standard (TV/Kite): volume is always on.
    const volumeStudy = computedNow.find(({ data: c }) => c.g === "volume");
    const showVolume =
      (volumeStudy && volumeStudy.study.visible) || (!volumeStudy);
    const hasAnyVolume = data.some((c) => Number(c.volume) > 0);
    if (showVolume && hasAnyVolume) {
      const vol = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: true,
      }, pane);
      vol.setData(data.map((cc, i) => {
        const prev = i > 0 ? data[i - 1].close : cc.open;
        const up = cc.close >= prev;
        return {
          time: toTime(cc.time),
          value: cc.volume,
          color: up ? tk.upFill : tk.downFill,
        };
      }));
      volumeSeriesRef.current = vol;
      pane++;
    }



    for (const { study, data: c } of computedNow) {
      if (!study.visible) continue;
      const def = defByType(study.type);
      if (def.group !== "oscillator") continue;
      const col = study.colors;
      const w = study.lineWidth;
      if (c.g === "single") {
        if (c.hist) {
          const h = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: true }, pane);
          h.setData(data.flatMap((cc, i) => (c.line[i] != null ? [{ time: toTime(cc.time), value: c.line[i] as number, color: (c.line[i] as number) >= 0 ? tk.upFill : tk.downFill }] : [])));
        } else {
          const s = paneLine(c.line, col[0], pane, w);
          (c.guides ?? []).forEach((g) => guide(s, g));
        }
      } else if (c.g === "obv") {
        const line = paneLine(c.line, col[0], pane, w);
        if (c.ma.some((v) => v != null)) paneLine(c.ma, col[1] ?? tk.neutral, pane, 1);
        guide(line, 0);
        const lastIdx = c.line.length - 1;
        obvLiveRef.current = {
          series: line,
          accBefore: (c.line[lastIdx - 1] as number) ?? 0,
          prevClose: data[lastIdx - 1]?.close ?? data[lastIdx]?.close ?? 0,
        };
      } else if (c.g === "macd") {
        const h = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
        h.setData(data.flatMap((cc, i) => (c.hist[i] != null ? [{ time: toTime(cc.time), value: c.hist[i] as number, color: (c.hist[i] as number) >= 0 ? tk.upFill : tk.downFill }] : [])));
        paneLine(c.macd, col[0], pane, w);
        paneLine(c.signal, col[1], pane, w);
      } else if (c.g === "dual") {
        const s = paneLine(c.a, col[0], pane, w);
        paneLine(c.b, col[1], pane, w);
        (c.guides ?? []).forEach((g) => guide(s, g));
      } else if (c.g === "adx") {
        const s = paneLine(c.adx, col[0], pane, w);
        paneLine(c.plusDi, col[1], pane, 1);
        paneLine(c.minusDi, col[2], pane, 1);
        (c.guides ?? []).forEach((g) => guide(s, g));
      }
      pane++;
    }
    // Sub-pane sizing. The auto split (up to 55% of chart height, min 90px,
    // cap 180) is only applied when the pane SET changes — otherwise a data
    // poll would rebuild the chart and stomp whatever height the user just
    // dragged. Dragged heights are captured on teardown and replayed here.
    const panes = chart.panes();
    const subCount = Math.max(0, panes.length - 1);
    const paneSig = [
      showVolume && hasAnyVolume ? "volume" : "",
      ...computedNow.filter(({ study }) => study.visible && defByType(study.type).group === "oscillator").map(({ study }) => study.id),
    ].filter(Boolean).join("|");
    paneSigRef.current = paneSig;
    if (subCount > 0) {
      const chartH = fill ? (el.clientHeight || height) : height;
      const saved = paneHeightsRef.current;
      const usable =
        saved && saved.sig === paneSig && saved.heights.length === subCount &&
        saved.heights.every((h) => h >= 40) &&
        saved.heights.reduce((a, b) => a + b, 0) <= chartH * 0.85
          ? saved.heights
          : null;
      if (usable) {
        for (let i = 1; i < panes.length; i++) panes[i].setHeight(usable[i - 1]);
      } else {
        const budget = Math.max(180, Math.floor(chartH * 0.55));
        const per = Math.max(90, Math.min(180, Math.floor(budget / subCount)));
        for (let i = 1; i < panes.length; i++) panes[i].setHeight(per);
        paneHeightsRef.current = { sig: paneSig, heights: new Array(subCount).fill(per) };
      }
    } else {
      paneHeightsRef.current = null;
    }


    // ---- crosshair legend ----
    const byTime = new Map(data.map((c) => [timeKey(c.time), c]));
    const idxByTime = new Map(data.map((c, i) => [timeKey(c.time), i]));
    chart.subscribeCrosshairMove((param) => {
      if (!param.time) { setLegend(null); setHoverIdx(null); return; }
      const key = timeKey(param.time);
      setLegend(byTime.get(key) ?? null);
      setHoverIdx(idxByTime.get(key) ?? null);
    });

    // ---- click a pattern marker → open its explanation ----
    chart.subscribeClick((param) => {
      const pick = onPatternPickRef.current;
      if (!pick || !param.time) return;
      const idx = idxByTime.get(timeKey(param.time));
      if (idx == null) return;
      const { marks, shapes } = patternHitsRef.current;
      const mark = marks.find((m) => m.index === idx);
      if (mark) { pick({ kind: "candle", result: mark }); return; }
      const shape = shapes.find((s) => s.endIndex === idx || s.triggerIndex === idx)
        ?? shapes.find((s) => idx >= s.startIndex && idx <= s.endIndex);
      if (shape) pick({ kind: "shape", result: shape });
    });

    // Preserve the view across every rebuild of the SAME chart, anchored to the
    // newest bar. New/updated/trimmed bars must never re-frame the viewport —
    // only a genuine identity change (symbol, timeframe, chart type, scale)
    // re-frames to that interval's default window.
    const identity = `${viewportKey ?? "default"}|${chartType}|${sLog ? "log" : "lin"}`;
    const sameIdentity = identity === identityRef.current;
    if (!sameIdentity) {
      userInteractedRef.current = false;
      followLiveRef.current = true;
      viewAnchorRef.current = null;
      setAtLiveEdge(true);
    }
    dataLenRef.current = data.length;
    const lastIdx = data.length - 1;
    const applyRange = () => {
      // This runs on a freshly created chart, which has no viewport of its own:
      // skipping it would leave lightweight-charts' default frame on screen —
      // that WAS the "it reset itself to default" bug. Always apply; when the
      // identity is unchanged the range applied is the user's own edge-anchored
      // view, so it is a no-op visually.
      programmaticRangeRef.current = true;

      const anchor = viewAnchorRef.current;
      if (sameIdentity && anchor && !followLiveRef.current) {
        // Held range: re-derive indices from the right edge so appended or
        // trimmed bars can't slide the window into the past.
        const to = lastIdx - anchor.barsFromEnd;
        chart.timeScale().setVisibleLogicalRange({ from: to - anchor.span, to });
      } else if (sameIdentity && anchor) {
        // Following the live edge: keep the zoom level, stay glued to the last
        // bar with TradingView's right-hand air.
        chart.timeScale().setVisibleLogicalRange({ from: lastIdx - anchor.span + RIGHT_AIR, to: lastIdx + RIGHT_AIR });
      } else if (visibleBars && data.length > visibleBars) {
        // Deep series stay fully loaded; the viewport just opens on the most
        // recent `visibleBars` so a 20-year chart isn't squashed by default.
        chart.timeScale().setVisibleLogicalRange({ from: lastIdx - visibleBars + 1, to: lastIdx + RIGHT_AIR });

      } else {
        chart.timeScale().fitContent();
      }
      requestAnimationFrame(() => { programmaticRangeRef.current = false; });
    };
    // Indicator panes are still sizing on this frame; applying the range after
    // layout settles stops the visible one-off re-frame. On an unchanged
    // identity one pass is enough — a second pass can stomp a fresh gesture.
    applyRange();
    if (!sameIdentity) requestAnimationFrame(applyRange);

    identityRef.current = identity;

    // Track the range continuously so a rebuild always has the latest, and
    // detect whether the user is parked at the live edge or scrolled back.
    chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (!r) return;
      const from = r.from as number;
      const to = r.to as number;
      const barsFromEnd = Math.max(0, dataLenRef.current - 1 - to);
      viewAnchorRef.current = { span: Math.max(1, to - from), barsFromEnd };
      if (!programmaticRangeRef.current) {
        userInteractedRef.current = true;
        // Within one bar of the newest print counts as "at the live edge".
        const live = barsFromEnd <= 1;
        if (live !== followLiveRef.current) setAtLiveEdge(live);
        followLiveRef.current = live;
      }
    });


    const doResize = () => {
      const w = el.clientWidth;
      const h = fill ? el.clientHeight : height;
      if (w > 0 && h > 0) chart.resize(w, h);
    };
    requestAnimationFrame(doResize);
    const ro = new ResizeObserver(doResize);
    ro.observe(el);

    return () => {
      const r = chart.timeScale().getVisibleLogicalRange();
      if (r) {
        const to = r.to as number;
        viewAnchorRef.current = {
          span: Math.max(1, to - (r.from as number)),
          barsFromEnd: Math.max(0, dataLenRef.current - 1 - to),
        };
      }

      // Capture any height the user dragged so the next rebuild replays it.
      try {
        const ps = chart.panes();
        if (ps.length > 1) {
          const heights = ps.slice(1).map((pn) => pn.getHeight());
          if (heights.every((h) => h > 0)) {
            const snap = { sig: paneSigRef.current, heights };
            paneHeightsRef.current = snap;
            safeStorage.setJSON(paneStoreKeyRef.current, snap);
          }
        }
      } catch { /* noop */ }
      ro.disconnect();
      try { markersPlugins.forEach((p) => p.detach()); } catch { /* noop */ }
      try { primitives.forEach((vp) => (priceSeries as any).detachPrimitive?.(vp)); } catch { /* noop */ }
      obvLiveRef.current = null;
      chart.remove();
      chartRef.current = null;
      priceSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, [renderTick, height, fill, chartType, intraday, sGrid, sLog, sPriceLine, sSessionBreaks, sMagnet, visibleBars, viewportKey, paneResetToken]);

  // ---- support/resistance price lines, applied without rebuilding ----
  // These values come off the live snapshot, so the array identity changes on
  // every quote tick. Drawing them here (keyed by VALUE, not identity) keeps
  // the chart — and the user's zoom — untouched.
  const priceLinesSig = useMemo(
    () => (priceLines ?? []).map((p) => `${p.price}|${p.label}|${p.color}`).join(","),
    [priceLines],
  );
  const priceLinesRef = useRef(priceLines);
  priceLinesRef.current = priceLines;
  useEffect(() => {
    const series = priceSeriesRef.current;
    if (!series) return;
    const created = (priceLinesRef.current ?? []).map((pl) =>
      series.createPriceLine({
        price: pl.price, color: pl.color, lineWidth: 1,
        lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: pl.label,
      }),
    );
    return () => {
      for (const line of created) {
        try { series.removePriceLine(line); } catch { /* series already gone */ }
      }
    };
  }, [priceLinesSig, renderTick]);




  // ---- live tick: move/extend the rightmost bar without rebuilding the chart ----
  useEffect(() => {
    const series = priceSeriesRef.current;
    const base = liveBarRef.current;
    if (!series || !base) return;
    // Never synthesise bars outside the session. A delayed/stale quote arriving
    // on a holiday or after close used to roll brand-new bars stamped "now",
    // which put a phantom (e.g. "02 Aug") label on the axis and a flat
    // O=H=L=C / zero-volume candle in the header.
    if (!marketOpen) return;
    if (livePrice == null && liveVolume == null) return;

    const close = livePrice != null && Number.isFinite(livePrice) ? livePrice : base.close;
    const nowSec = Math.floor(Date.now() / 1000);
    const gap = medianGapRef.current;
    const baseTime = typeof base.rawTime === "number" ? base.rawTime : 0;
    // Bar-boundary roll: if wall-clock has crossed one full `gap` past the
    // current bar's open time, emit a fresh bar (open=prev close) instead of
    // stretching a monster bar. Guards: only for intraday (gap < 1 day) and
    // when we actually have a numeric base time.
    if (gap > 0 && gap < 86_400 && baseTime > 0 && nowSec >= baseTime + gap && livePrice != null) {
      const newTime = baseTime + Math.floor((nowSec - baseTime) / gap) * gap;
      const fresh = {
        seriesTime: newTime as UTCTimestamp,
        rawTime: newTime,
        open: base.close, high: Math.max(base.close, close), low: Math.min(base.close, close),
        close, volume: 0,
      };
      liveBarRef.current = fresh;
      if (obvLiveRef.current) {
        obvLiveRef.current = {
          series: obvLiveRef.current.series,
          accBefore: obvLiveRef.current.accBefore + (base.close > obvLiveRef.current.prevClose ? base.volume : base.close < obvLiveRef.current.prevClose ? -base.volume : 0),
          prevClose: base.close,
        };
      }
      try {
        if (chartType === "line" || chartType === "area" || chartType === "baseline") {
          series.update({ time: fresh.seriesTime, value: close });
        } else {
          series.update({ time: fresh.seriesTime, open: fresh.open, high: fresh.high, low: fresh.low, close: fresh.close });
        }
      } catch { /* noop */ }
      setLiveBar({ time: fresh.rawTime, open: fresh.open, high: fresh.high, low: fresh.low, close: fresh.close, volume: fresh.volume });
      return;
    }
    // `liveVolume` is the broker's DAY-CUMULATIVE traded quantity. On a daily
    // bar that is exactly the bar's volume; on a 5m bar it is not — dropping it
    // in raw drew a single 37.97M bar dwarfing the whole session. For intraday
    // the forming bar gets the delta: cumulative minus everything already
    // printed today.
    let nextVol = base.volume;
    if (liveVolume != null && Number.isFinite(liveVolume)) {
      if (typeof base.rawTime === "number") {
        // Sum of volume already printed today, cached per (bar, candle set) so
        // a fast tick stream doesn't rescan the whole series on every quote.
        const dayStart = Math.floor((base.rawTime + IST_OFFSET_SEC) / 86_400) * 86_400 - IST_OFFSET_SEC;
        const cacheKey = `${dayStart}|${base.rawTime}|${candles.length}`;
        let printed = printedVolRef.current?.key === cacheKey ? printedVolRef.current.value : null;
        if (printed == null) {
          printed = 0;
          for (const c of candles) {
            const t = typeof c.time === "number" ? c.time : 0;
            if (t >= dayStart && t < base.rawTime) printed += Number(c.volume) || 0;
          }
          printedVolRef.current = { key: cacheKey, value: printed };
        }
        const delta = liveVolume - printed;
        nextVol = delta > 0 ? Math.max(base.volume, delta) : base.volume;

      } else {
        nextVol = Math.max(base.volume, liveVolume);
      }
    }
    const updated = { ...base, high: Math.max(base.high, close), low: Math.min(base.low, close), close, volume: nextVol };

    liveBarRef.current = updated;
    if (livePrice != null && Number.isFinite(livePrice)) {
      if (chartType === "line" || chartType === "area" || chartType === "baseline") {
        series.update({ time: updated.seriesTime, value: close });
      } else {
        series.update({ time: updated.seriesTime, open: updated.open, high: updated.high, low: updated.low, close: updated.close });
      }
    }
    const vol = volumeSeriesRef.current;
    if (vol && (liveVolume != null || livePrice != null)) {
      try {
        vol.update({
          time: updated.seriesTime,
          value: updated.volume,
          color: updated.close >= updated.open ? readTokens().upFill : readTokens().downFill,
        } as any);
      } catch { /* noop */ }
    }
    // OBV must track the forming bar too — otherwise it freezes at the last
    // completed bar while price/volume keep moving during the session.
    const obvLive = obvLiveRef.current;
    if (obvLive) {
      const dir = updated.close > obvLive.prevClose ? 1 : updated.close < obvLive.prevClose ? -1 : 0;
      try {
        obvLive.series.update({ time: updated.seriesTime, value: obvLive.accBefore + dir * updated.volume } as any);
      } catch { /* noop */ }
    }
    setLiveBar({ time: updated.rawTime, open: updated.open, high: updated.high, low: updated.low, close: updated.close, volume: updated.volume });
    // Depend on `candles` too: after the main chart-build effect (line ~667)
    // rebuilds the series on a candle refetch, `priceSeriesRef` is a fresh
    // instance and internal `liveBar` state is reset. Without a candles dep
    // here, the overlay would only re-fire when livePrice VALUE changed —
    // so a live LTP that had already arrived would stay unapplied and the
    // legend fell back to the EOD `candles[last]`, showing e.g. 1683.90
    // while the Quote panel showed the live 1720.30.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePrice, liveVolume, candles, marketOpen]);


  // ---- legend rows (value at crosshair, else last bar) ----
  const legendRows: LegendRow[] = useMemo(() => {
    const idx = hoverIdx ?? cleanCandles.length - 1;
    const compact = (n: number) => Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
    const BOUNDED_100 = new Set(["rsi", "stochRsi", "mfi", "aroon", "stoch", "williamsR", "uo"]);
    const COMPACT_TYPES = new Set(["obv", "ad", "volume"]);
    const rows: LegendRow[] = [];
    for (const { study, data: c } of computed) {
      // VWAP is intraday-only — hide the row on daily+ TFs to match the chart.
      if (study.type === "vwap" && !intraday) continue;
      const prim = primaryOf(c);
      const v = prim && idx >= 0 && idx < prim.length ? prim[idx] : null;
      if (c.g === "vprofile") {
        const up = vpStats?.upVol ?? 0;
        const dn = vpStats?.downVol ?? 0;
        const tot = up + dn;
        const buyPct = tot > 0 ? (up / tot) * 100 : null;
        rows.push({
          id: study.id,
          label: "Volume Profile",
          color: study.colors[0],
          value: vpStats?.poc != null
            ? `POC ${vpStats.poc.toFixed(2)} · buy ${buyPct != null ? buyPct.toFixed(0) : "—"}% / sell ${buyPct != null ? (100 - buyPct).toFixed(0) : "—"}%`
            : "—",
          visible: study.visible,
        });
        continue;
      }
      const isVol = c.g === "volume";
      const latestLive = liveBar && idx === cleanCandles.length - 1 ? liveBar : null;
      const rawVol = isVol && idx >= 0 ? (latestLive ?? cleanCandles[idx])?.volume ?? null : null;
      const val: string = isVol
        ? (rawVol != null ? compact(rawVol) : "—")
        : v == null
          ? "—"
          : COMPACT_TYPES.has(study.type)
            ? compact(v as number)
            : BOUNDED_100.has(study.type)
              ? (v as number).toFixed(1)
              : (v as number).toFixed(2);
      // For histogram indicators (AO), swatch reflects the current bar's sign
      // so the legend colour matches what the user sees on the chart.
      let swatch = study.colors[0];
      if (c.g === "single" && c.hist && v != null) {
        swatch = (v as number) >= 0 ? "var(--chart-up)" : "var(--chart-down)";
      }
      rows.push({
        id: study.id,
        label: studyLabel(study),
        color: swatch,
        value: val,
        visible: study.visible,
      });
    }
    return rows;
  }, [computed, hoverIdx, cleanCandles, intraday, liveBar, vpStats]);

  const last = liveBar ?? cleanCandles[cleanCandles.length - 1];
  const prev = cleanCandles[cleanCandles.length - 2];
  const hoveringLatest = hoverIdx === cleanCandles.length - 1;
  const l = hoveringLatest && liveBar ? liveBar : legend ?? last;
  // Δ vs previous bar (crosshair-aware): when hovering, compare to the bar
  // just before the hovered one; otherwise compare last bar to the one prior.
  // This is the only "change" we show in the legend — the old same-bar
  // (close-open)/open readout showed +0.00% on a fresh live bar and
  // contradicted the Quote panel's prev-close-anchored change.
  const refPrev = hoverIdx != null && hoverIdx > 0 ? cleanCandles[hoverIdx - 1] : prev;
  const deltaVsPrev = l && refPrev ? l.close - refPrev.close : null;
  const deltaPctVsPrev = l && refPrev && refPrev.close ? ((l.close - refPrev.close) / refPrev.close) * 100 : null;
  const chg = deltaPctVsPrev;

  // Keyboard shortcuts: +/− zoom, ←/→ pan, Alt+H fit, Alt+L toggle log.
  // Re-glue the viewport to the newest bar, keeping the current zoom level.
  const jumpToLatest = () => {
    const chart = chartRef.current;
    if (!chart) return;
    const ts = chart.timeScale();
    const span = viewAnchorRef.current?.span;
    programmaticRangeRef.current = true;
    if (span && dataLenRef.current > span) {
      const to = dataLenRef.current - 1 + RIGHT_AIR;
      ts.setVisibleLogicalRange({ from: to - span, to });
    } else {
      ts.scrollToRealTime();
    }
    followLiveRef.current = true;
    setAtLiveEdge(true);
    requestAnimationFrame(() => { programmaticRangeRef.current = false; });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {

    const chart = chartRef.current;
    if (!chart) return;
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    // Alt+H = full history (explicit, so it leaves the live edge); Alt+E (or
    // End) snaps back to the latest bar.
    if (e.altKey && (e.key === "h" || e.key === "H")) {
      ts.fitContent();
      followLiveRef.current = false;
      setAtLiveEdge(false);
      e.preventDefault();
      return;
    }
    if (e.key === "End" || (e.altKey && (e.key === "e" || e.key === "E"))) {
      jumpToLatest();
      e.preventDefault();
      return;
    }

    if (!range) return;
    const span = (range.to as number) - (range.from as number);
    if (e.key === "+" || e.key === "=") {
      ts.setVisibleLogicalRange({ from: (range.from as number) + span * 0.15, to: range.to });
      e.preventDefault();
    } else if (e.key === "-" || e.key === "_") {
      ts.setVisibleLogicalRange({ from: (range.from as number) - span * 0.15, to: range.to });
      e.preventDefault();
    } else if (e.key === "ArrowLeft") {
      const d = span * 0.1;
      ts.setVisibleLogicalRange({ from: (range.from as number) - d, to: (range.to as number) - d });
      e.preventDefault();
    } else if (e.key === "ArrowRight") {
      const d = span * 0.1;
      ts.setVisibleLogicalRange({ from: (range.from as number) + d, to: (range.to as number) + d });
      e.preventDefault();
    }
  };

  const ariaLabel = last
    ? `Price chart. Last ${last.close.toFixed(2)}, change ${(chg ?? 0).toFixed(2)} percent, ${candles.length} bars.`
    : "Price chart. No data.";

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{ position: "relative", width: "100%", outline: "none", ...(fill ? { height: "100%", minHeight: 260 } : { minHeight: height }) }}
    >
      {candles.length === 0 && (
        <div style={{
          position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "var(--font-hud)", fontSize: 11, letterSpacing: "0.1em",
          color: "var(--text-dim)", textTransform: "uppercase", pointerEvents: "none",
        }}>
          No data for this range
        </div>
      )}
      {source && (() => {
        // Tell the truth about provenance: only a Kotak read during/after the
        // session is "live". Yahoo is delayed, cached bars are not a fresh
        // read at all, and "none" means the broker gave us nothing.
        const chip = source === "kotak_neo"
          ? { text: "kotak · live", tone: "var(--chart-up)", edge: "var(--chart-up-edge)", title: "Kotak Neo — live" }
          : source === "yahoo"
          ? { text: "yahoo · delayed", tone: "var(--chart-neutral)", edge: "var(--chart-neutral-edge)", title: "Yahoo Finance — delayed ~15m" }
          : source === "cache"
          ? { text: "cached", tone: "var(--chart-neutral)", edge: "var(--chart-neutral-edge)", title: "Stored bars — no fresh broker read on this request" }
          : source === "quote"
          ? { text: "quote · live", tone: "var(--chart-up)", edge: "var(--chart-up-edge)", title: "Live Kotak quote — historical candles route is unavailable" }
          : source === "quote_delayed"
          ? { text: "quote · delayed", tone: "var(--chart-neutral)", edge: "var(--chart-neutral-edge)", title: "Seeded from a delayed quote — Kotak is unavailable" }
          : { text: "no live feed", tone: "var(--danger)", edge: "var(--chart-down-edge)", title: "Kotak Neo is unavailable — no live data is being substituted" };
        return (
          <div
            title={chip.title}
            style={{
              position: "absolute", top: 4, right: 8, zIndex: 3, pointerEvents: "none",
              fontFamily: "var(--font-hud)", fontSize: 9, letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: chip.tone,
              background: "rgba(4,16,22,0.6)",
              border: `1px solid ${chip.edge}`,
              padding: "1px 6px", borderRadius: 2,
            }}
          >
            {chip.text}
          </div>
        );
      })()}
      {l && (
        <div style={{
          position: "absolute", top: 4, left: 6, zIndex: 3, pointerEvents: "none",
          fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.08em",
          color: "var(--text-dim)", display: "flex", gap: 10, flexWrap: "wrap",
          background: "rgba(4,16,22,0.55)", padding: "2px 6px", borderRadius: 2,
        }}>
          <span>O <b style={{ color: "var(--text)" }}>{l.open.toFixed(2)}</b></span>
          <span>H <b style={{ color: "var(--text)" }}>{l.high.toFixed(2)}</b></span>
          <span>L <b style={{ color: "var(--text)" }}>{l.low.toFixed(2)}</b></span>
          <span>C <b style={{ color: l.close >= l.open ? UP : DOWN }}>{l.close.toFixed(2)}</b></span>
          {deltaVsPrev != null && deltaPctVsPrev != null && (
            <span style={{ color: deltaVsPrev >= 0 ? UP : DOWN }}>
              {deltaPctVsPrev >= 0 ? "+" : ""}{deltaPctVsPrev.toFixed(2)}% ({deltaVsPrev >= 0 ? "+" : ""}{deltaVsPrev.toFixed(2)}) <span style={{ opacity: 0.6 }}>vs prev close</span>
            </span>
          )}
          {/* Volume intentionally omitted here — shown in the volume pane's right axis and legend row to avoid a triple readout. */}
        </div>
      )}
      {(onToggleStudy || onEditStudy || onRemoveStudy) && (
        <ChartLegend
          rows={legendRows}
          onToggle={(id) => onToggleStudy?.(id)}
          onEdit={(id) => onEditStudy?.(id)}
          onRemove={(id) => onRemoveStudy?.(id)}
        />
      )}
      {!atLiveEdge && cleanCandles.length > 0 && (
        <button
          type="button"
          onClick={jumpToLatest}
          title="Jump to the latest bar and resume following the live edge"
          style={{
            position: "absolute", bottom: 26, right: 10, zIndex: 4,
            fontFamily: "var(--font-hud)", fontSize: 9, letterSpacing: "0.12em",
            textTransform: "uppercase", cursor: "pointer",
            color: "var(--chart-up)", background: "rgba(4,16,22,0.75)",
            border: "1px solid var(--chart-up-edge)", padding: "2px 7px", borderRadius: 2,
          }}
        >
          Latest ›
        </button>
      )}
      <div ref={ref} style={{ width: "100%", height: "100%" }} />
    </div>

  );
}
