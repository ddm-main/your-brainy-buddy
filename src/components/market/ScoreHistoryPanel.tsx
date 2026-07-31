// Analysis rail: the score and *how it was arrived at* — nothing else.
// History, forward returns and model calibration each get their own page;
// the rail links to them instead of cramming four dense tables into 280px.
import { useNavigate } from "react-router-dom";
import { Chip } from "@/components/hud/HudControls";
import { useScoreHistory } from "@/lib/market/scoreHistory";
import { V4_WEIGHTS } from "@/lib/market/scoreLab";
import { SCORE_BAND_STRONG, SCORE_BAND_MODERATE, SCORE_BAND_WEAK } from "@/lib/market/scoreBands";

const BUCKETS = Object.keys(V4_WEIGHTS);

function bandOf(v: number): { label: string; tone: "ok" | "warn" | "err" | undefined } {
  if (v >= SCORE_BAND_STRONG) return { label: "STRONG", tone: "ok" };
  if (v >= SCORE_BAND_MODERATE) return { label: "MODERATE", tone: undefined };
  if (v >= SCORE_BAND_WEAK) return { label: "WATCH", tone: "warn" };
  return { label: "WEAK", tone: "err" };
}

export function ScoreHistoryPanel({ symbol, exchange }: { symbol: string; exchange: string }) {
  const nav = useNavigate();
  const { data: history = [], isLoading } = useScoreHistory(symbol, exchange, 10);
  const latest = history.length ? history[history.length - 1] : null;

  const label = (t: string) => (
    <div className="hud-label" style={{ fontSize: 9, letterSpacing: "0.14em", color: "var(--accent-soft)", margin: "10px 0 4px" }}>
      {t}
    </div>
  );

  const buckets = (latest?.buckets ?? {}) as Record<string, number>;
  const coverage = (latest?.coverage ?? {}) as Record<string, number>;
  // Renormalised ceiling per bucket: v4 redistributes the weight of buckets
  // that had no data, so "max" is not the raw weight.
  const present = BUCKETS.filter((b) => Number(coverage[b] ?? 0) >= 0.35);
  const presentW = present.reduce((s, b) => s + V4_WEIGHTS[b], 0) || 100;
  const ceilingOf = (b: string) => (present.includes(b) ? (V4_WEIGHTS[b] * 100) / presentW : 0);
  const rows = BUCKETS
    .map((b) => ({ b, pts: Number(buckets[b] ?? 0), max: ceilingOf(b), cov: Number(coverage[b] ?? 0) }))
    .sort((a, b) => b.pts - a.pts);

  return (
    <>
      {label("Breakout Score")}
      {isLoading ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>loading…</div>
      ) : !latest || latest.score == null ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
          No v4 snapshot for {symbol} yet — the nightly aggregates pass writes one per session.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontFamily: "var(--font-hud)", fontSize: 30, color: "var(--text)", lineHeight: 1 }}>
              {latest.score}
            </span>
            <Chip tone={bandOf(latest.score).tone}>{bandOf(latest.score).label}</Chip>
            {latest.rank_pct != null && <Chip>top {Math.round(100 - latest.rank_pct)}%</Chip>}
          </div>
          <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 3 }}>
            {new Date(latest.trade_date).toLocaleDateString([], { day: "2-digit", month: "short", year: "2-digit" })}
            {latest.context_neutral ? " · neutral context" : ""}
            {latest.is_liquid_tradable === false ? " · illiquid" : ""}
          </div>

          {label("How this score was built")}
          <div style={{ fontSize: 10, fontFamily: "var(--font-hud)" }}>
            {rows.map((r) => {
              const pctOfMax = r.max > 0 ? Math.max(0, Math.min(1, r.pts / r.max)) : 0;
              const dead = r.max === 0;
              return (
                <div key={r.b} style={{ padding: "2px 0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                    <span style={{ color: dead ? "var(--text-muted)" : "var(--text-dim)" }}>{r.b}</span>
                    <span style={{ color: dead ? "var(--warn)" : "var(--text)", fontVariantNumeric: "tabular-nums" }}>
                      {dead ? "no data" : `${r.pts.toFixed(1)} / ${r.max.toFixed(1)}`}
                    </span>
                  </div>
                  <div style={{ height: 3, background: "var(--edge)", marginTop: 2 }}>
                    <div style={{ width: `${pctOfMax * 100}%`, height: "100%", background: dead ? "var(--warn)" : "var(--accent)" }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.5 }}>
            Weights of buckets with no data are redistributed across the rest, so the ceiling shown
            per bucket is the renormalised one, not the raw weight.
          </div>
        </>
      )}

      <div style={{ display: "grid", gap: 4, marginTop: 10 }}>
        <button className="hud-btn" style={{ fontSize: 10 }} onClick={() => nav(`/market/score/${encodeURIComponent(symbol)}`)}>
          Score history →
        </button>
        <button className="hud-btn" style={{ fontSize: 10 }} onClick={() => nav(`/market/score/${encodeURIComponent(symbol)}?tab=returns`)}>
          Forward returns →
        </button>
        <button className="hud-btn" style={{ fontSize: 10 }} onClick={() => nav("/market/calibration")}>
          Model calibration lab →
        </button>
      </div>
    </>
  );
}

export default ScoreHistoryPanel;
