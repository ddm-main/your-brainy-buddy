// lightweight-charts workbench themed for the HUD.
// Renders price (candles/bars/line/area) + optional overlays (EMA/SMA/BB/VWAP)
// computed client-side, with RSI and MACD in their own panes and a crosshair
// OHLC legend. Fills its container height when `fill` is set.
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
import { bollinger, ema, macd, rsi, sma, vwap, type Num } from "@/lib/market/chartIndicators";

export type ChartType = "candles" | "bars" | "line" | "area";

export interface IndicatorFlags {
  ema20?: boolean;
  ema50?: boolean;
  ema200?: boolean;
  sma20?: boolean;
  bb?: boolean;
  vwap?: boolean;
  rsi?: boolean;
  macd?: boolean;
  volume?: boolean;
}

const OVERLAY_COLORS: Record<string, string> = {
  ema20: "#7fe9ff",
  ema50: "#ffb84d",
  ema200: "#b85cff",
  sma20: "#5c8aff",
  vwap: "#ff8ae2",
};

const UP = "#6bffb0";
const DOWN = "#ff5f6d";

export function CandleChart({
  candles,
  priceLines,
  height = 420,
  fill = false,
  chartType = "candles",
  indicators = { ema20: true, ema50: true, volume: true },
}: {
  candles: CandleDto[];
  priceLines?: Array<{ price: number; label: string; color: string }>;
  height?: number;
  fill?: boolean;
  chartType?: ChartType;
  indicators?: IndicatorFlags;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [legend, setLegend] = useState<CandleDto | null>(null);

  // Indicator math is pure per candle set — memo once per data change.
  const calc = useMemo(() => ({
    ema20: indicators.ema20 ? ema(candles, 20) : null,
    ema50: indicators.ema50 ? ema(candles, 50) : null,
    ema200: indicators.ema200 ? ema(candles, 200) : null,
    sma20: indicators.sma20 ? sma(candles, 20) : null,
    bb: indicators.bb ? bollinger(candles, 20, 2) : null,
    vwap: indicators.vwap ? vwap(candles) : null,
    rsi: indicators.rsi ? rsi(candles, 14) : null,
    macd: indicators.macd ? macd(candles, 12, 26, 9) : null,
  }), [candles, indicators.ema20, indicators.ema50, indicators.ema200, indicators.sma20, indicators.bb, indicators.vwap, indicators.rsi, indicators.macd]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // lightweight-charts silently renders nothing when times are out of order
    // or duplicated. Sort ascending and dedupe by time before feeding series.
    const _tKey = (t: string | number) => (typeof t === "number" ? t : Date.parse(t) / 1000);
    const _sorted = [...candles].sort((a, b) => _tKey(a.time) - _tKey(b.time));
    const _seen = new Set<string>();
    const _candles = _sorted.filter((c) => {
      const k = String(c.time);
      if (_seen.has(k)) return false;
      _seen.add(k);
      return true;
    });
    // shadow the outer `candles` so all setData calls below use cleaned data
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const candlesRaw = candles;
    candles = _candles as typeof candles;

    const chart = createChart(el, {
      // We drive width/height ourselves via `chart.resize` + ResizeObserver;
      // autoSize sometimes leaves the canvas at its default 300×150 when the
      // chart is created inside a freshly-mounted flex container.
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
      timeScale: { borderColor: "rgba(53,214,237,0.15)", timeVisible: candles.some((c) => typeof c.time === "number") },
      crosshair: {
        vertLine: { color: "rgba(53,214,237,0.4)", labelBackgroundColor: "#0a2733" },
        horzLine: { color: "rgba(53,214,237,0.4)", labelBackgroundColor: "#0a2733" },
      },
    });
    chartRef.current = chart;

    const toTime = (t: string | number) =>
      (typeof t === "number" ? (t as UTCTimestamp) : t) as any;

    // ---- price series (pane 0) ----
    let priceSeries: ISeriesApi<any>;
    if (chartType === "bars") {
      priceSeries = chart.addSeries(BarSeries, { upColor: UP, downColor: DOWN, thinBars: false });
      priceSeries.setData(candles.map((c) => ({ time: toTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    } else if (chartType === "line") {
      priceSeries = chart.addSeries(LineSeries, { color: "#35d6ed", lineWidth: 2 });
      priceSeries.setData(candles.map((c) => ({ time: toTime(c.time), value: c.close })));
    } else if (chartType === "area") {
      priceSeries = chart.addSeries(AreaSeries, {
        lineColor: "#35d6ed", lineWidth: 2,
        topColor: "rgba(53,214,237,0.25)", bottomColor: "rgba(53,214,237,0.02)",
      });
      priceSeries.setData(candles.map((c) => ({ time: toTime(c.time), value: c.close })));
    } else {
      priceSeries = chart.addSeries(CandlestickSeries, {
        upColor: UP, downColor: DOWN,
        borderUpColor: UP, borderDownColor: DOWN,
        wickUpColor: "rgba(107,255,176,0.6)", wickDownColor: "rgba(255,95,109,0.6)",
      });
      priceSeries.setData(candles.map((c) => ({ time: toTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    }

    // ---- volume (pane 0 sub-scale) ----
    if (indicators.volume !== false) {
      const volSeries = chart.addSeries(HistogramSeries, {
        priceScaleId: "vol",
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volSeries.setData(candles.map((c) => ({
        time: toTime(c.time),
        value: c.volume,
        color: c.close >= c.open ? "rgba(107,255,176,0.25)" : "rgba(255,95,109,0.25)",
      })));
    }

    // ---- price-pane overlays ----
    const overlayLine = (values: Num[] | null | undefined, color: string, width: 1 | 2 = 1, style?: LineStyle) => {
      if (!values) return;
      const line = chart.addSeries(LineSeries, {
        color, lineWidth: width, lineStyle: style,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      line.setData(candles.flatMap((c, i) => (values[i] != null ? [{ time: toTime(c.time), value: values[i] as number }] : [])));
    };
    overlayLine(calc.ema20, OVERLAY_COLORS.ema20);
    overlayLine(calc.ema50, OVERLAY_COLORS.ema50);
    overlayLine(calc.ema200, OVERLAY_COLORS.ema200);
    overlayLine(calc.sma20, OVERLAY_COLORS.sma20);
    overlayLine(calc.vwap, OVERLAY_COLORS.vwap, 1, LineStyle.Dotted);
    if (calc.bb) {
      overlayLine(calc.bb.upper, "rgba(127,233,255,0.35)");
      overlayLine(calc.bb.mid, "rgba(127,233,255,0.2)", 1, LineStyle.Dashed);
      overlayLine(calc.bb.lower, "rgba(127,233,255,0.35)");
    }

    // ---- sub-panes ----
    let pane = 1;
    if (calc.rsi) {
      const rsiSeries = chart.addSeries(LineSeries, {
        color: "#c792ea", lineWidth: 1,
        priceLineVisible: false, lastValueVisible: true,
      }, pane);
      rsiSeries.setData(candles.flatMap((c, i) => (calc.rsi![i] != null ? [{ time: toTime(c.time), value: calc.rsi![i] as number }] : [])));
      rsiSeries.createPriceLine({ price: 70, color: "rgba(255,95,109,0.4)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
      rsiSeries.createPriceLine({ price: 30, color: "rgba(107,255,176,0.4)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
      pane++;
    }
    if (calc.macd) {
      const histSeries = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
      histSeries.setData(candles.flatMap((c, i) => (calc.macd!.hist[i] != null ? [{
        time: toTime(c.time), value: calc.macd!.hist[i] as number,
        color: (calc.macd!.hist[i] as number) >= 0 ? "rgba(107,255,176,0.5)" : "rgba(255,95,109,0.5)",
      }] : [])));
      const macdLine = chart.addSeries(LineSeries, { color: "#35d6ed", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, pane);
      macdLine.setData(candles.flatMap((c, i) => (calc.macd!.macd[i] != null ? [{ time: toTime(c.time), value: calc.macd!.macd[i] as number }] : [])));
      const sigLine = chart.addSeries(LineSeries, { color: "#ffb84d", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, pane);
      sigLine.setData(candles.flatMap((c, i) => (calc.macd!.signal[i] != null ? [{ time: toTime(c.time), value: calc.macd!.signal[i] as number }] : [])));
      pane++;
    }
    // keep sub-panes compact relative to price
    const panes = chart.panes();
    for (let i = 1; i < panes.length; i++) panes[i].setHeight(110);

    for (const pl of priceLines ?? []) {
      priceSeries.createPriceLine({
        price: pl.price, color: pl.color, lineWidth: 1,
        lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: pl.label,
      });
    }

    // ---- crosshair legend ----
    const byTime = new Map(candles.map((c) => [String(c.time), c]));
    chart.subscribeCrosshairMove((param) => {
      if (!param.time) { setLegend(null); return; }
      setLegend(byTime.get(String(param.time)) ?? null);
    });

    chart.timeScale().fitContent();

    // `autoSize: true` handles most resize cases, but we still guard against
    // the first-paint race where the container has zero size when the chart
    // is created (the canvas would stay at its 300×150 default). Force one
    // resize on the next frame and any time the container changes.
    const doResize = () => {
      const w = el.clientWidth;
      const h = fill ? el.clientHeight : height;
      if (w > 0 && h > 0) chart.resize(w, h);
    };
    requestAnimationFrame(doResize);
    const ro = new ResizeObserver(doResize);
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, calc, priceLines, height, fill, chartType, indicators.volume]);

  const last = candles[candles.length - 1];
  const l = legend ?? last;
  const chg = l && candles.length > 1
    ? ((l.close - l.open) / l.open) * 100
    : null;

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
      <div ref={ref} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
