import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X, ScanSearch } from "lucide-react";
import { Btn, Chip } from "@/components/hud/HudControls";
import { tierOf } from "@/lib/market/patternLabels";
import type { CandleMark, ChartShape } from "../../../supabase/functions/_shared/market/pattern-series";

const tierReason = (key: string) => {
  const t = tierOf(key);
  return t === "key"
    ? "Key tier: a standalone reversal/continuation read with a defined trigger and invalidation, so it gets a label on the chart."
    : t === "context"
      ? "Context tier: supports a thesis but is not tradeable alone — drawn as an unlabelled dot."
      : "Noise tier: fires constantly and mostly describes the bar (inside/narrow bars, gaps, wick shapes, swing labels) — hidden by default.";
};

type Candle = { time: number | string; open: number; high: number; low: number; close: number; volume: number };
export type PatternSelection = { kind: "candle"; result: CandleMark } | { kind: "shape"; result: ChartShape };

const number = (v: number | null | undefined, digits = 2) => v == null || !Number.isFinite(v) ? "—" : v.toFixed(digits);
const time = (v: number | string) => new Date(typeof v === "number" ? v * 1000 : v).toLocaleString([], {
  day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});

export function PatternDetailDialog({ selection, candles, timeframe, onClose, onFocus, siblings = [] }: {
  selection: PatternSelection | null;
  candles: Candle[];
  timeframe: string;
  onClose: () => void;
  onFocus: (start: number, end: number) => void;
  /** Every candlestick read on the series — used to list the other reads
   *  that printed on the same bar. */
  siblings?: CandleMark[];
}) {
  useEffect(() => {
    if (!selection) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selection, onClose]);
  if (!selection) return null;

  const result = selection.result;
  // Exact detection window: the pattern's own bars. Candle reads carry their
  // start/end (a 3-bar morning star is 3 bars, not an arbitrary trailing 12).
  const start = Math.max(0, selection.kind === "candle" ? selection.result.startIndex : selection.result.startIndex);
  const end = selection.kind === "candle" ? selection.result.endIndex : selection.result.endIndex;
  // Show the window plus a little prior context so the "vs previous bar"
  // conditions in the rule are visible too.
  const ctxStart = Math.max(0, start - 2);
  const rows = candles.slice(ctxStart, end + 1).slice(-14).map((c, offset, all) => {
    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    const upper = c.high - Math.max(c.open, c.close);
    const lower = Math.min(c.open, c.close) - c.low;
    const prior = all.slice(0, offset).map((x) => x.volume).filter((v) => v > 0);
    const avg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : null;
    return { c, range, body, upper, lower, relVol: avg ? c.volume / avg : null, inWindow: ctxStart + offset >= start };
  });
  const shape = selection.kind === "shape" ? selection.result : null;
  const mark = selection.kind === "candle" ? selection.result : null;
  const tone = result.tone === "bullish" ? "ok" : result.tone === "bearish" ? "err" : "neutral";
  const lastClose = candles[candles.length - 1]?.close ?? null;
  const dist = (target: number | null | undefined) => {
    if (target == null || lastClose == null || !Number.isFinite(target)) return "—";
    const diff = target - lastClose;
    const pct = lastClose ? (diff / lastClose) * 100 : 0;
    return `${diff >= 0 ? "+" : ""}${diff.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
  };
  const triggerTarget = shape ? (shape.tone === "bearish" ? shape.lower : shape.upper) ?? shape.level : null;
  const invalidTarget = shape
    ? (shape.tone === "bearish" ? shape.upper : shape.lower)
    : mark?.invalidateLevel ?? null;
  const alsoHere = mark
    ? siblings.filter((m) => m.index === mark.index && m.key !== mark.key)
    : [];
  const evidence = Object.entries((shape ? shape.evidence : mark?.evidence) ?? {});
  const windowText = `${end - start + 1} bar${end - start === 0 ? "" : "s"} · ${time(candles[start]?.time ?? Date.now())} → ${time(candles[end]?.time ?? Date.now())} (${timeframe})`;

  return createPortal(
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{
      position: "fixed", inset: 0, zIndex: 10020, background: "var(--overlay)", display: "grid", placeItems: "center", padding: 16,
    }}>
      <section role="dialog" aria-modal="true" aria-label={`${result.label} details`} className="hud-panel" style={{
        width: "min(1120px, calc(100vw - 32px))", maxHeight: "min(820px, calc(100vh - 32px))", overflow: "auto",
        background: "var(--panel-tint-heavy)", padding: 16,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--edge)", paddingBottom: 10 }}>
          <div style={{ minWidth: 0 }}>
            <div className="hud-h" style={{ fontSize: 15 }}>{result.label}</div>
            <div className="hud-label">{timeframe} · {time(candles[end]?.time ?? Date.now())}</div>
          </div>
          <Chip tone={tone}>{result.tone}</Chip>
          <Chip tone={shape?.status === "triggered" ? "ok" : "accent"}>{shape?.status ?? "confirmed"}</Chip>
          <Chip tone="neutral">{result.confidence}%</Chip>
          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <Btn size="sm" onClick={() => onFocus(start, end)} title="Focus pattern on chart"><ScanSearch size={13} /> Focus</Btn>
            <Btn size="sm" onClick={onClose} title="Close"><X size={13} /></Btn>
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 8, margin: "12px 0" }}>
          <Fact label="Window" value={windowText} />
          {shape && <Fact label="Upper / lower" value={`${number(shape.upper)} / ${number(shape.lower)}`} />}
          {shape?.level != null && <Fact label="Level" value={number(shape.level)} />}
          {shape && <Fact label="Touches" value={`${shape.evidence.upper_touches ?? 0} upper / ${shape.evidence.lower_touches ?? 0} lower`} />}
          {shape && <Fact label="To trigger" value={`${number(triggerTarget)} · ${dist(triggerTarget)}`} />}
          {invalidTarget != null && <Fact label="To invalidation" value={`${number(invalidTarget)} · ${dist(invalidTarget)}`} />}
          {!shape && <Fact label="Last close" value={number(lastClose)} />}
          {!shape && alsoHere.length > 0 && <Fact label="Also on this bar" value={alsoHere.map((m) => m.label).join(", ")} />}
        </div>


        {evidence.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div className="hud-label" style={{ marginBottom: 6 }}>Measured evidence</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 6 }}>
              {evidence.map(([k, v]) => (
                <div key={k} style={{ border: "1px solid var(--edge-soft)", padding: "4px 8px" }}>
                  <div className="hud-label" style={{ fontSize: 9 }}>{k.replace(/_/g, " ")}</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)" }}>
                    {Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) : String(v)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 8, marginBottom: 12 }}>
          <Evidence label="Detected because" value={result.formula} />
          <Evidence label="Confirmation" value={shape?.confirmText ?? mark?.confirmText ?? "Completed candle satisfies the geometry and context rule."} />
          <Evidence label="Invalidation" value={shape?.invalidateText ?? mark?.invalidateText ?? "A later candle must confirm direction; the candle itself is historical evidence."} />
          <Evidence label="Why this tier" value={tierReason(result.key)} />
        </div>


        <div className="hud-label" style={{ marginBottom: 6 }}>Referenced candles · pattern bars highlighted</div>
        <div style={{ overflowX: "auto", border: "1px solid var(--edge)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 10 }}>
            <thead><tr>{["Time","Open","High","Low","Close","Body","Upper wick","Lower wick","Range","Volume","Rel vol"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>{rows.map(({ c, body, upper, lower, range, relVol, inWindow }) => (
              <tr key={String(c.time)} style={inWindow ? { background: "rgba(53,214,237,0.07)" } : undefined}>{[
                time(c.time), number(c.open), number(c.high), number(c.low), number(c.close), number(body), number(upper), number(lower), number(range), Math.round(c.volume).toLocaleString(), relVol == null ? "—" : `${relVol.toFixed(2)}×`,
              ].map((v, i) => <td key={i} style={td}>{v}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      </section>
    </div>, document.body,
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div style={{ borderLeft: "2px solid var(--edge)", padding: "5px 8px" }}><div className="hud-label">{label}</div><div style={{ fontSize: 11, color: "var(--text)" }}>{value}</div></div>;
}
function Evidence({ label, value }: { label: string; value: string }) {
  return <div style={{ border: "1px solid var(--edge)", padding: 10 }}><div className="hud-label" style={{ color: "var(--accent)" }}>{label}</div><div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>{value}</div></div>;
}
const th: React.CSSProperties = { textAlign: "right", color: "var(--accent-soft)", padding: "7px 8px", borderBottom: "1px solid var(--edge)", whiteSpace: "nowrap" };
const td: React.CSSProperties = { textAlign: "right", color: "var(--text-dim)", padding: "6px 8px", borderBottom: "1px solid var(--edge-soft)", whiteSpace: "nowrap" };