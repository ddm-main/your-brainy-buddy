// Dual-thumb range slider with a histogram of the underlying distribution.
// Tickertape-style: bars covered by [lo, hi] paint in --accent, bars outside
// mute out. Manual min/max number inputs elsewhere stay authoritative — this
// component is a drag-to-adjust visualization layer.
import { useMemo, useRef, useCallback, useEffect, useState } from "react";

interface Props {
  /** Raw numeric distribution — nulls filtered internally. */
  values: Array<number | null | undefined>;
  min: number;
  max: number;
  step?: number;
  lo?: number | "";
  hi?: number | "";
  onChange: (patch: { min?: number | ""; max?: number | "" }) => void;
  bins?: number;
  height?: number;
}

export function HistogramSlider({
  values, min, max, step = 1, lo, hi, onChange, bins = 24, height = 44,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<"lo" | "hi" | null>(null);

  const loNum = lo === "" || lo === undefined ? min : Number(lo);
  const hiNum = hi === "" || hi === undefined ? max : Number(hi);

  const histogram = useMemo(() => {
    const nums: number[] = [];
    for (const v of values) if (v != null && Number.isFinite(v)) nums.push(v as number);
    if (nums.length === 0) return { counts: new Array(bins).fill(0), maxCount: 0, total: 0 };
    const buckets = new Array(bins).fill(0);
    const span = max - min || 1;
    for (const v of nums) {
      const idx = Math.min(bins - 1, Math.max(0, Math.floor(((v - min) / span) * bins)));
      buckets[idx]++;
    }
    return { counts: buckets, maxCount: Math.max(...buckets), total: nums.length };
  }, [values, min, max, bins]);

  const pctOf = (v: number) => {
    const span = max - min || 1;
    return Math.max(0, Math.min(100, ((v - min) / span) * 100));
  };
  const loPct = pctOf(loNum);
  const hiPct = pctOf(hiNum);

  const clampToStep = (v: number) => {
    const clamped = Math.max(min, Math.min(max, v));
    if (!step) return clamped;
    return Math.round(clamped / step) * step;
  };

  const posToValue = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return min;
    const pct = (clientX - rect.left) / rect.width;
    return clampToStep(min + pct * (max - min));
  };

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!drag) return;
    const v = posToValue(e.clientX);
    if (drag === "lo") onChange({ min: Math.min(v, hiNum) });
    else onChange({ max: Math.max(v, loNum) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, hiNum, loNum, onChange]);

  const onPointerUp = useCallback(() => setDrag(null), []);

  useEffect(() => {
    if (!drag) return;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [drag, onPointerMove, onPointerUp]);

  const trackClick = (e: React.PointerEvent) => {
    const v = posToValue(e.clientX);
    // Snap the nearer thumb.
    const distLo = Math.abs(v - loNum);
    const distHi = Math.abs(v - hiNum);
    if (distLo <= distHi) onChange({ min: Math.min(v, hiNum) });
    else onChange({ max: Math.max(v, loNum) });
  };

  const barW = 100 / bins;

  return (
    <div style={{ width: 220, userSelect: "none" }} title={histogram.total ? `${histogram.total} stocks in range` : "no data"}>
      {/* Histogram */}
      <div style={{ position: "relative", height, display: "flex", alignItems: "flex-end", gap: 1 }}>
        {histogram.counts.map((c, i) => {
          const binMid = min + ((i + 0.5) / bins) * (max - min);
          const inRange = binMid >= loNum && binMid <= hiNum;
          const h = histogram.maxCount ? Math.max(2, (c / histogram.maxCount) * (height - 4)) : 2;
          return (
            <div key={i}
              style={{
                width: `${barW}%`,
                height: h,
                background: inRange ? "var(--accent)" : "var(--edge-strong)",
                opacity: inRange ? 0.75 : 0.4,
                transition: "background 120ms, opacity 120ms",
              }} />
          );
        })}
      </div>
      {/* Track + thumbs */}
      <div
        ref={trackRef}
        onPointerDown={trackClick}
        style={{
          position: "relative", height: 14, marginTop: 4, cursor: "pointer",
          background: "var(--edge)", borderRadius: 2,
        }}
      >
        {/* Selected span */}
        <div style={{
          position: "absolute", top: 0, bottom: 0,
          left: `${loPct}%`, width: `${Math.max(0, hiPct - loPct)}%`,
          background: "rgba(53,214,237,0.28)", borderTop: "1px solid var(--accent)", borderBottom: "1px solid var(--accent)",
        }} />
        {/* Thumbs */}
        {(["lo", "hi"] as const).map((k) => {
          const pct = k === "lo" ? loPct : hiPct;
          return (
            <div
              key={k}
              onPointerDown={(e) => { e.stopPropagation(); (e.target as HTMLElement).setPointerCapture(e.pointerId); setDrag(k); }}
              style={{
                position: "absolute", top: -3, left: `calc(${pct}% - 6px)`,
                width: 12, height: 20, borderRadius: 2,
                background: "var(--accent)", border: "1px solid var(--bg-panel)",
                cursor: "ew-resize", boxShadow: "0 1px 4px rgba(0,0,0,0.6)",
              }}
              role="slider"
              aria-valuemin={min}
              aria-valuemax={max}
              aria-valuenow={k === "lo" ? loNum : hiNum}
            />
          );
        })}
      </div>
    </div>
  );
}
