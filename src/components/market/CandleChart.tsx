// lightweight-charts workbench themed for the HUD.
// Renders price (candles/bars/line/area) + a list of indicator "studies".
// Overlays draw on the price pane; oscillators each get their own sub-pane.
// Each study carries its own params/source/colours/width (see indicatorRegistry).
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
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
  | { g: "psar"; dots: Num[] }
  | { g: "ichimoku"; tenkan: Num[]; kijun: Num[]; spanA: Num[]; spanB: Num[]; base: number }
  | { g: "volume" }
  | { g: "single"; line: Num[]; guides?: number[]; hist?: boolean }
  | { g: "macd"; macd: Num[]; signal: Num[]; hist: Num[] }
  | { g: "dual"; a: Num[]; b: Num[]; guides?: number[] }
  | { g: "adx"; adx: Num[]; plusDi: Num[]; minusDi: Num[]; guides?: number[] };

function computeStudy(candles: CandleDto[], s: Study): Computed {
  const p = s.params;
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
    case "psar": return { g: "psar", dots: psar(candles, p.step, p.max) };
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
    case "psar": return c.dots;
    case "ichimoku": return c.tenkan;
    case "single": return c.line;
    case "macd": return c.macd;
    case "dual": return c.a;
    case "adx": return c.adx;
    default: return null;
  }
}

export function CandleChart({
  candles,
  priceLines,
  height = 420,
  fill = false,
  chartType = "candles",
  studies,
  intraday = false,
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

  const computed = useMemo(
    () => studies.map((s) => ({ study: s, data: computeStudy(candles, s) })),
    [candles, studies],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // lightweight-charts silently renders nothing when times are out of order
    // or duplicated. Sort ascending and dedupe by time before feeding series.
    const _tKey = (t: string | number) => (typeof t === "number" ? t : Date.parse(t) / 1000);
    const _sorted = [...candles].sort((a, b) => _tKey(a.time) - _tKey(b.time));
    const _seen = new Set<string>();
    const cleaned = _sorted.filter((c) => {
      const k = String(c.time);
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
        vertLines: { color: "rgba(53,214,237,0.06)" },
        horzLines: { color: "rgba(53,214,237,0.06)" },
      },
      rightPriceScale: { borderColor: "rgba(53,214,237,0.15)" },
      timeScale: { borderColor: "rgba(53,214,237,0.15)", timeVisible: data.some((c) => typeof c.time === "number") },
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

    const overlayLine = (values: Num[], color: string, width = 1, style?: LineStyle, lastVal = false, offset = 0) => {
      const line = chart.addSeries(LineSeries, {
        color, lineWidth: lw(width), lineStyle: style,
        priceLineVisible: false, lastValueVisible: lastVal, crosshairMarkerVisible: false,
      });
      line.setData(lineData(values, offset));
    };

    // ---- overlays (visible, price pane) ----
    for (const { study, data: c } of computed) {
      if (!study.visible) continue;
      const def = defByType(study.type);
      if (def.group !== "overlay") continue;
      const col = study.colors;
      const w = study.lineWidth;
      if (c.g === "ma") {
        // VWAP resets each session; on non-intraday timeframes it collapses to
        // the typical price, so flag it as dashed to signal it's not meaningful.
        const style = study.type === "vwap" && !intraday ? LineStyle.Dashed : undefined;
        overlayLine(c.line, col[0], w, style, true);
      } else if (c.g === "band") {
        overlayLine(c.upper, col[0], w);
        overlayLine(c.mid, col[1], w, LineStyle.Dashed);
        overlayLine(c.lower, col[2], w);
      } else if (c.g === "supertrend") {
        const upData = data.flatMap((cc, i) => (c.line[i] != null && c.dir[i] === 1 ? [{ time: toTime(cc.time), value: c.line[i] as number }] : []));
        const dnData = data.flatMap((cc, i) => (c.line[i] != null && c.dir[i] === -1 ? [{ time: toTime(cc.time), value: c.line[i] as number }] : []));
        const upS = chart.addSeries(LineSeries, { color: UP, lineWidth: lw(w), priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        upS.setData(upData);
        const dnS = chart.addSeries(LineSeries, { color: DOWN, lineWidth: lw(w), priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        dnS.setData(dnData);
      } else if (c.g === "psar") {
        const s = chart.addSeries(LineSeries, { color: col[0], lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.6, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        s.setData(lineData(c.dots));
      } else if (c.g === "ichimoku") {
        overlayLine(c.tenkan, col[0], w);
        overlayLine(c.kijun, col[1], w);
        // Senkou spans are displaced forward by `base` bars (TradingView).
        overlayLine(c.spanA, col[2], w, LineStyle.Dashed, false, c.base);
        overlayLine(c.spanB, col[3], w, LineStyle.Dashed, false, c.base);
      } else if (c.g === "volume") {
        const volSeries = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
        chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        volSeries.setData(data.map((cc) => ({ time: toTime(cc.time), value: cc.volume, color: cc.close >= cc.open ? "rgba(107,255,176,0.25)" : "rgba(255,95,109,0.25)" })));
      }
    }

    for (const pl of priceLines ?? []) {
      priceSeries.createPriceLine({ price: pl.price, color: pl.color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: pl.label });
    }

    // ---- oscillators (visible, one sub-pane each) ----
    let pane = 1;
    const paneLine = (values: Num[], color: string, p: number, width = 1) => {
      const s = chart.addSeries(LineSeries, { color, lineWidth: lw(width), priceLineVisible: false, lastValueVisible: true }, p);
      s.setData(lineData(values));
      return s;
    };
    const guide = (s: ISeriesApi<any>, price: number) =>
      s.createPriceLine({ price, color: "rgba(127,233,255,0.28)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });

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
    const panes = chart.panes();
    for (let i = 1; i < panes.length; i++) panes[i].setHeight(110);

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
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, computed, priceLines, height, fill, chartType, intraday]);

  // ---- legend rows (value at crosshair, else last bar) ----
  const legendRows: LegendRow[] = useMemo(() => {
    const idx = hoverIdx ?? candles.length - 1;
    return computed.map(({ study, data: c }) => {
      const prim = primaryOf(c);
      const v = prim && idx >= 0 && idx < prim.length ? prim[idx] : null;
      return {
        id: study.id,
        label: studyLabel(study),
        color: study.colors[0],
        value: c.g === "volume" ? "" : v != null ? (v as number).toFixed(2) : "—",
        visible: study.visible,
      };
    });
  }, [computed, hoverIdx, candles.length]);

  const last = candles[candles.length - 1];
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
          <span>V <b style={{ color: "var(--text)" }}>{Intl.NumberFormat("en-IN", { notation: "compact" }).format(l.volume)}</b></span>
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
