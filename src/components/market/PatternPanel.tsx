// Candles & Patterns — reads the *chart's* candle array, so whatever timeframe
// the chart is on (1m → 1W) is exactly what gets scanned. Detection itself is
// the shared engine used by the EOD scorer, so a read here and a read in the
// breakout score can never disagree.
import { useMemo, useState } from "react";
import { HudPanel } from "@/components/hud/HudPanel";
import { detectPatternSeries, type CandleMark, type ChartShape } from "../../../supabase/functions/_shared/market/pattern-series";
import { REGISTRY_BY_KEY } from "@/lib/market/patternLabels";
import { PatternDetailDialog, type PatternSelection } from "@/components/market/PatternDetailDialog";

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Tone = "bullish" | "bearish" | "neutral";

const TONE_COLOR: Record<Tone, string> = {
  bullish: "var(--ok)",
  bearish: "var(--danger)",
  neutral: "var(--text-dim)",
};

function Chip({ tone, title, children }: { tone: Tone; title?: string; children: React.ReactNode }) {
  return (
    <span title={title} style={{
      fontSize: 10, lineHeight: 1.6, padding: "1px 6px", borderRadius: 2,
      border: `1px solid ${TONE_COLOR[tone]}`, color: TONE_COLOR[tone], whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

function barsAgo(n: number) {
  return n === 0 ? "now" : `${n}b ago`;
}

export function PatternPanel({
  candles, tf, index = "A4", actions, onFocus, chartOn = false, onToggleChart,
}: {
  candles: Candle[] | undefined;
  tf: string;
  index?: string;
  actions?: React.ReactNode;
  onFocus?: (startIndex: number, endIndex: number) => void;
  /** Whether the pattern studies are currently drawn on the chart. */
  chartOn?: boolean;
  onToggleChart?: (on: boolean) => void;
}) {
  const [tab, setTab] = useState<"candles" | "structures">("candles");
  const [window, setWindow] = useState(20);
  const [selection, setSelection] = useState<PatternSelection | null>(null);

  const { marks, shapes } = useMemo<{ marks: CandleMark[]; shapes: ChartShape[] }>(
    () => (candles && candles.length > 5 ? detectPatternSeries(candles) : { marks: [], shapes: [] }),
    [candles],
  );

  const last = (candles?.length ?? 0) - 1;
  const recentMarks = useMemo(
    () => marks.filter((m) => last - m.index < window).sort((a, b) => b.index - a.index),
    [marks, last, window],
  );
  const activeShapes = useMemo(
    () => shapes.filter((s) => last - s.endIndex < Math.max(window, 10)).sort((a, b) => b.endIndex - a.endIndex),
    [shapes, last, window],
  );

  const bull = recentMarks.filter((m) => m.tone === "bullish").length;
  const bear = recentMarks.filter((m) => m.tone === "bearish").length;
  const bias = bull === bear ? "balanced" : bull > bear ? "bullish" : "bearish";
  const biasTone: Tone = bull === bear ? "neutral" : bull > bear ? "bullish" : "bearish";

  return (
    <HudPanel flow title="Candles & Patterns" index={index} actions={actions}>
      {!candles || candles.length < 6 ? (
        <div className="hud-label" style={{ padding: 8 }}>not enough bars on this timeframe</div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            <span className="hud-label">{tf} · last {window} bars</span>
            <Chip tone={biasTone}>{bias} {bull}↑/{bear}↓</Chip>
            {onToggleChart && (
              <button type="button" onClick={() => onToggleChart(!chartOn)}
                title={chartOn ? "Remove pattern drawings from the chart" : "Draw every detected pattern on the chart"}
                style={{
                  fontSize: 10, padding: "1px 6px", background: "transparent", cursor: "pointer",
                  border: `1px solid ${chartOn ? "var(--accent)" : "var(--edge)"}`,
                  color: chartOn ? "var(--accent)" : "var(--text-dim)", textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}>
                {chartOn ? "on chart ✓" : "show on chart"}
              </button>
            )}
            <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              {[10, 20, 50].map((w) => (
                <button key={w} type="button" onClick={() => setWindow(w)}
                  style={{
                    fontSize: 10, padding: "1px 6px", background: "transparent", cursor: "pointer",
                    border: `1px solid ${w === window ? "var(--accent)" : "var(--edge)"}`,
                    color: w === window ? "var(--accent)" : "var(--text-dim)",
                  }}>{w}</button>
              ))}
            </span>
          </div>

          <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
            {(["candles", "structures"] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)}
                style={{
                  fontSize: 10, padding: "2px 8px", background: "transparent", cursor: "pointer",
                  border: `1px solid ${tab === t ? "var(--accent)" : "var(--edge)"}`,
                  color: tab === t ? "var(--accent)" : "var(--text-dim)", textTransform: "uppercase",
                }}>
                {t === "candles" ? `Candlesticks (${recentMarks.length})` : `Structures (${activeShapes.length})`}
              </button>
            ))}
          </div>

          {tab === "candles" ? (
            recentMarks.length === 0 ? (
              <div className="hud-label" style={{ padding: 6 }}>no candlestick reads in window</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {recentMarks.slice(0, 24).map((m, i) => (
                  <button type="button" key={`${m.index}-${m.key}-${i}`} onClick={() => setSelection({ kind: "candle", result: m })}
                    className="focus-outline" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, background: "transparent", border: 0, padding: 0, width: "100%", cursor: "pointer" }}>
                    <Chip tone={m.tone} title={REGISTRY_BY_KEY[m.key]?.blurb}>{m.label}</Chip>
                    <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: 10 }}>
                      {barsAgo(last - m.index)}
                    </span>
                  </button>
                ))}
              </div>
            )
          ) : activeShapes.length === 0 ? (
            <div className="hud-label" style={{ padding: 6 }}>no chart structures in window</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {activeShapes.slice(0, 20).map((s, i) => (
                <button type="button" key={`${s.key}-${s.endIndex}-${i}`} onClick={() => setSelection({ kind: "shape", result: s })}
                  className="focus-outline" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, background: "transparent", border: 0, padding: 0, width: "100%", cursor: "pointer" }}>
                  <Chip tone={s.tone} title={REGISTRY_BY_KEY[s.key]?.blurb}>{s.label}</Chip>
                  <span style={{ fontSize: 9, color: s.status === "triggered" ? "var(--ok)" : "var(--accent)" }}>{s.status}</span>
                  <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: 10 }}>
                    {s.level != null ? `lvl ${s.level.toFixed(2)} · ` : ""}{s.endIndex - s.startIndex + 1} bars
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {candles && <PatternDetailDialog selection={selection} candles={candles} timeframe={tf} siblings={marks}
        onClose={() => setSelection(null)} onFocus={(start, end) => { onFocus?.(start, end); setSelection(null); }} />}
    </HudPanel>
  );
}
