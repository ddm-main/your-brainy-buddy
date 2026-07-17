// lightweight-charts wrapper themed for the HUD.
import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { CandleDto } from "@/lib/market/types";

const EMA_COLORS: Record<string, string> = {
  ema20: "#7fe9ff",
  ema50: "#ffb84d",
  ema200: "#b85cff",
};

export function CandleChart({
  candles,
  emas,
  priceLines,
  height = 420,
}: {
  candles: CandleDto[];
  emas?: Record<string, Array<{ t: number; v: number | null }>>;
  priceLines?: Array<{ price: number; label: string; color: string }>;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const chart = createChart(el, {
      height,
      layout: {
        background: { color: "transparent" },
        textColor: "#6a93a8",
        fontFamily: "system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: false,
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

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#6bffb0",
      downColor: "#ff5f6d",
      borderUpColor: "#6bffb0",
      borderDownColor: "#ff5f6d",
      wickUpColor: "rgba(107,255,176,0.6)",
      wickDownColor: "rgba(255,95,109,0.6)",
    });
    candleSeries.setData(
      candles.map((c) => ({ time: toTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close })),
    );

    const volSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "vol",
      priceFormat: { type: "volume" },
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volSeries.setData(
      candles.map((c) => ({
        time: toTime(c.time),
        value: c.volume,
        color: c.close >= c.open ? "rgba(107,255,176,0.25)" : "rgba(255,95,109,0.25)",
      })),
    );

    if (emas) {
      // EMA overlay points are keyed by unix time; map to the candle time format.
      const timeByUnix = new Map<number, string | number>();
      for (const c of candles) {
        const unix = typeof c.time === "number" ? c.time : Math.floor(new Date(`${c.time}T00:00:00Z`).getTime() / 1000);
        timeByUnix.set(unix, c.time);
      }
      for (const [name, series] of Object.entries(emas)) {
        const color = EMA_COLORS[name] ?? "#5c8aff";
        const line = chart.addSeries(LineSeries, {
          color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        line.setData(
          series
            .filter((p) => p.v != null && timeByUnix.has(p.t))
            .map((p) => ({ time: toTime(timeByUnix.get(p.t)!), value: p.v as number })),
        );
      }
    }

    for (const pl of priceLines ?? []) {
      candleSeries.createPriceLine({
        price: pl.price,
        color: pl.color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: pl.label,
      });
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, emas, priceLines, height]);

  return <div ref={ref} style={{ width: "100%", minHeight: height }} />;
}
