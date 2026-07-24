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
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type UTCTimestamp,
} from "lightweight-charts";

import type { CandleDto } from "@/lib/market/types";
import {
  ad, adx, ao, atr, bollingerV, cci, chaikinOsc, cmf, demaV, donchian, emaV, envelopesV,
  hmaV, ichimoku, keltner, macd, mfi, mom, obv, psar, roc, rsi, smaV, sourceValues,
  stochastic, stochRsi, stddevV, supertrend, temaV, trix, uo, vortex, vwap, vwma, williamsR,
  wmaV, aroon, type Num,
} from "@/lib/market/chartIndicators";
import { defByType, studyLabel, type Study } from "@/lib/market/indicatorRegistry";
import { ChartLegend, type LegendRow } from "@/components/market/ChartLegend";

export type ChartType = "candles" | "bars" | "line" | "area";

const UP = "#6bffb0";
const DOWN = "#ff5f6d";

// ---- per-study compute (pure) ----
type Computed =
  | { g: "ma"; line: Num[] }
  | { g: "band"; upper: Num[]; mid: Num[]; lower: Num[] }
  | { g: "supertrend"; line: Num[]; dir: Array<1 | -1 | null> }
  | { g: "psar"; sar: Num[]; dir: Array<1 | -1 | null> }
  | { g: "ichimoku"; tenkan: Num[]; kijun: Num[]; spanA: Num[]; spanB: Num[]; base: number }
  | { g: "volume" }
  | { g: "single"; line: Num[]; guides?: number[]; hist?: boolean }
  | { g: "macd"; macd: Num[]; signal: Num[]; hist: Num[] }
  | { g: "dual"; a: Num[]; b: Num[]; guides?: number[] }
  | { g: "adx"; adx: Num[]; plusDi: Num[]; minusDi: Num[]; guides?: number[] };

function computeStudy(candles: CandleDto[], s: Study): Computed {
  // Clamp any user param to a safe integer (period-like) so a bad -5 doesn't
  // silently cascade into all-null output. Ratios (mult/step/pct) are clamped
  // to a small positive floor but keep decimals.
  const p: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.params)) {
    const n = Number(v);
    if (!Number.isFinite(n)) { p[k] = 1; continue; }
    if (k === "mult" || k === "step" || k === "max" || k === "pct") p[k] = Math.max(0.001, n);
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
    case "obv": return { g: "single", line: obv(candles) };
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
}) {

  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [legend, setLegend] = useState<CandleDto | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // preserve zoom/scroll across rebuilds; reset only when the candle set changes
  const rangeRef = useRef<{ from: number; to: number } | null>(null);
  const candlesKeyRef = useRef<string>("");
  // live-tick plumbing: refs so the 1s price update never tears down the chart
  const priceSeriesRef = useRef<ISeriesApi<any> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<any> | null>(null);
  const liveBarRef = useRef<{ seriesTime: any; rawTime: string | number; open: number; high: number; low: number; close: number; volume: number } | null>(null);
  const [liveBar, setLiveBar] = useState<CandleDto | null>(null);
  const s = settings ?? { grid: true, logScale: false, priceLine: true, sessionBreaks: false };
  // Deconstructed so effect dep can be primitive and stable across parent
  // renders when the settings object identity changes but values don't.
  const { grid: sGrid, logScale: sLog, priceLine: sPriceLine, sessionBreaks: sSessionBreaks } = s;


  const computed = useMemo(
    () => studies.map((s) => ({ study: s, data: computeStudy(candles, s) })),
    [candles, studies],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // lightweight-charts silently renders nothing when times are out of order
    // or duplicated. Normalise every time to a numeric epoch (seconds) before
    // sorting/deduping so ISO ↔ number mismatches from refresh races don't
    // slip through.
    const _epoch = (t: string | number): number => {
      if (typeof t === "number") return t;
      const parsed = Date.parse(t);
      return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
    };
    const _sorted = [...candles].sort((a, b) => _epoch(a.time) - _epoch(b.time));
    const _seen = new Set<number>();
    const cleaned = _sorted.filter((c) => {
      const k = _epoch(c.time);
      if (_seen.has(k)) return false;
      _seen.add(k);
      return true;
    });
    const data = cleaned;

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
      grid: {
        vertLines: { color: "rgba(53,214,237,0.06)", visible: sGrid },
        horzLines: { color: "rgba(53,214,237,0.06)", visible: sGrid },
      },
      rightPriceScale: {
        borderColor: "rgba(53,214,237,0.15)",
        mode: sLog ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
      },
      timeScale: {
        borderColor: "rgba(53,214,237,0.15)",
        timeVisible: data.some((c) => typeof c.time === "number"),
        // "Session breaks" hides the non-trading gaps by tightly packing bars
        // — LWC exposes this via `shiftVisibleRangeOnNewBar` + `barSpacing`;
        // the closest built-in is disabling `ticksVisible` on off-hours, but
        // the most visible knob is `rightOffset` + `fixLeftEdge`.
        rightOffset: sSessionBreaks ? 0 : 5,
      },
      crosshair: {
        vertLine: { color: "rgba(53,214,237,0.4)", labelBackgroundColor: "#0a2733" },
        horzLine: { color: "rgba(53,214,237,0.4)", labelBackgroundColor: "#0a2733" },
      },
    });
    chartRef.current = chart;


    const toTime = (t: string | number) => (typeof t === "number" ? (t as UTCTimestamp) : t) as any;
    const lw = (n: number) => Math.max(1, Math.min(4, Math.round(n))) as 1 | 2 | 3 | 4;
    const lineData = (values: Num[], offset = 0) =>
      data.flatMap((c, i) => {
        const vi = i - offset;
        return vi >= 0 && values[vi] != null ? [{ time: toTime(c.time), value: values[vi] as number }] : [];
      });

    // ---- price series (pane 0) ----
    let priceSeries: ISeriesApi<any>;
    if (chartType === "bars") {
      priceSeries = chart.addSeries(BarSeries, { upColor: UP, downColor: DOWN, thinBars: false });
      priceSeries.setData(data.map((c) => ({ time: toTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    } else if (chartType === "line") {
      priceSeries = chart.addSeries(LineSeries, { color: "#35d6ed", lineWidth: 2 });
      priceSeries.setData(data.map((c) => ({ time: toTime(c.time), value: c.close })));
    } else if (chartType === "area") {
      priceSeries = chart.addSeries(AreaSeries, { lineColor: "#35d6ed", lineWidth: 2, topColor: "rgba(53,214,237,0.25)", bottomColor: "rgba(53,214,237,0.02)" });
      priceSeries.setData(data.map((c) => ({ time: toTime(c.time), value: c.close })));
    } else {
      priceSeries = chart.addSeries(CandlestickSeries, {
        upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN,
        wickUpColor: "rgba(107,255,176,0.6)", wickDownColor: "rgba(255,95,109,0.6)",
      });
      priceSeries.setData(data.map((c) => ({ time: toTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
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

    for (const { study, data: c } of computed) {
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
        const upData: Array<{ time: any; value: number | null }> = [];
        const dnData: Array<{ time: any; value: number | null }> = [];
        for (let i = 0; i < data.length; i++) {
          const v = c.line[i];
          const d = c.dir[i];
          const t = toTime(data[i].time);
          if (v == null || d == null) continue;
          const prevDir = i > 0 ? c.dir[i - 1] : null;
          const flipped = prevDir != null && prevDir !== d;
          if (d === 1) {
            if (flipped) dnData.push({ time: t, value: null });
            upData.push({ time: t, value: v as number });
          } else {
            if (flipped) upData.push({ time: t, value: null });
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
      }

      // volume handled below in its own pane so it gets a proper K/M axis
    }

    for (const pl of priceLines ?? []) {
      priceSeries.createPriceLine({ price: pl.price, color: pl.color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: pl.label });
    }

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
    for (const { study, data: c } of computed) {
      if (!study.visible || c.g !== "volume") continue;
      const vol = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: true,
      }, pane);
      vol.setData(data.map((cc) => ({
        time: toTime(cc.time),
        value: cc.volume,
        color: cc.close >= cc.open ? "rgba(107,255,176,0.55)" : "rgba(255,95,109,0.55)",
      })));
      volumeSeriesRef.current = vol;
      pane++;
      break;
    }



    for (const { study, data: c } of computed) {
      if (!study.visible) continue;
      const def = defByType(study.type);
      if (def.group !== "oscillator") continue;
      const col = study.colors;
      const w = study.lineWidth;
      if (c.g === "single") {
        if (c.hist) {
          const h = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: true }, pane);
          h.setData(data.flatMap((cc, i) => (c.line[i] != null ? [{ time: toTime(cc.time), value: c.line[i] as number, color: (c.line[i] as number) >= 0 ? "rgba(107,255,176,0.5)" : "rgba(255,95,109,0.5)" }] : [])));
        } else {
          const s = paneLine(c.line, col[0], pane, w);
          (c.guides ?? []).forEach((g) => guide(s, g));
        }
      } else if (c.g === "macd") {
        const h = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
        h.setData(data.flatMap((cc, i) => (c.hist[i] != null ? [{ time: toTime(cc.time), value: c.hist[i] as number, color: (c.hist[i] as number) >= 0 ? "rgba(107,255,176,0.5)" : "rgba(255,95,109,0.5)" }] : [])));
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
    // Sub-pane sizing: split up to 55% of the chart height across all
    // oscillator/volume panes (min 90px each, cap 180) so the price pane
    // never collapses when the user stacks 3+ oscillators.
    const panes = chart.panes();
    const subCount = Math.max(0, panes.length - 1);
    if (subCount > 0) {
      const chartH = fill ? (el.clientHeight || height) : height;
      const budget = Math.max(180, Math.floor(chartH * 0.55));
      const per = Math.max(90, Math.min(180, Math.floor(budget / subCount)));
      for (let i = 1; i < panes.length; i++) panes[i].setHeight(per);
    }

    // ---- crosshair legend ----
    const byTime = new Map(data.map((c) => [String(c.time), c]));
    const idxByTime = new Map(data.map((c, i) => [String(c.time), i]));
    chart.subscribeCrosshairMove((param) => {
      if (!param.time) { setLegend(null); setHoverIdx(null); return; }
      const key = String(param.time);
      setLegend(byTime.get(key) ?? null);
      setHoverIdx(idxByTime.get(key) ?? null);
    });

    // preserve view across param edits; fit only on a new candle set
    const candlesKey = `${data.length}:${data[0] ? String(data[0].time) : ""}:${data[data.length - 1] ? String(data[data.length - 1].time) : ""}`;
    if (candlesKey === candlesKeyRef.current && rangeRef.current) {
      chart.timeScale().setVisibleLogicalRange(rangeRef.current);
    } else {
      chart.timeScale().fitContent();
    }
    candlesKeyRef.current = candlesKey;

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
      if (r) rangeRef.current = { from: r.from as number, to: r.to as number };
      ro.disconnect();
      try { markersPlugins.forEach((p) => p.detach()); } catch { /* noop */ }
      chart.remove();
      chartRef.current = null;
      priceSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, [candles, computed, priceLines, height, fill, chartType, intraday, sGrid, sLog, sPriceLine, sSessionBreaks]);


  // ---- live tick: move/extend the rightmost bar without rebuilding the chart ----
  useEffect(() => {
    const series = priceSeriesRef.current;
    const base = liveBarRef.current;
    if (!series || !base) return;
    if (livePrice == null && liveVolume == null) return;
    const close = livePrice != null && Number.isFinite(livePrice) ? livePrice : base.close;
    const nextVol = liveVolume != null && Number.isFinite(liveVolume) ? Math.max(base.volume, liveVolume) : base.volume;
    const updated = { ...base, high: Math.max(base.high, close), low: Math.min(base.low, close), close, volume: nextVol };
    liveBarRef.current = updated;
    if (livePrice != null && Number.isFinite(livePrice)) {
      if (chartType === "line" || chartType === "area") {
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
          color: updated.close >= updated.open ? "rgba(107,255,176,0.55)" : "rgba(255,95,109,0.55)",
        } as any);
      } catch { /* noop */ }
    }
    setLiveBar({ time: updated.rawTime, open: updated.open, high: updated.high, low: updated.low, close: updated.close, volume: updated.volume });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePrice, liveVolume]);


  // ---- legend rows (value at crosshair, else last bar) ----
  const legendRows: LegendRow[] = useMemo(() => {
    const idx = hoverIdx ?? candles.length - 1;
    const compact = (n: number) => Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
    const BOUNDED_100 = new Set(["rsi", "stochRsi", "mfi", "aroon", "stoch", "williamsR", "uo"]);
    const COMPACT_TYPES = new Set(["obv", "ad", "volume"]);
    const rows: LegendRow[] = [];
    for (const { study, data: c } of computed) {
      // VWAP is intraday-only — hide the row on daily+ TFs to match the chart.
      if (study.type === "vwap" && !intraday) continue;
      const prim = primaryOf(c);
      const v = prim && idx >= 0 && idx < prim.length ? prim[idx] : null;
      const isVol = c.g === "volume";
      const rawVol = isVol && idx >= 0 && candles[idx] ? candles[idx].volume : null;
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
        swatch = (v as number) >= 0 ? "#6bffb0" : "#ff5f6d";
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
  }, [computed, hoverIdx, candles.length, candles, intraday]);

  const last = liveBar ?? candles[candles.length - 1];
  const l = legend ?? last;
  const chg = l && candles.length > 1 ? ((l.close - l.open) / l.open) * 100 : null;

  return (
    <div style={{ position: "relative", width: "100%", ...(fill ? { height: "100%", minHeight: 260 } : { minHeight: height }) }}>
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
          {chg != null && <span style={{ color: chg >= 0 ? UP : DOWN }}>{chg >= 0 ? "+" : ""}{chg.toFixed(2)}%</span>}
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
      <div ref={ref} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
