// Analysis rail: one score, one 100-point distribution, one button.
// Everything deeper — sub-factor maths, penalties, criteria, history,
// forward returns, calibration — lives on /market/score/:symbol/explain.
import { useNavigate } from "react-router-dom";
import { Chip } from "@/components/hud/HudControls";
import { useScoreHistory } from "@/lib/market/scoreHistory";
import { buildBucketRows, bandOf, BUCKET_COLORS } from "@/lib/market/scoreExplain";
import { useLatestPriceSession } from "@/lib/market/hooks";
import { classifyFreshness } from "@/lib/market/freshness";

export function ScoreHistoryPanel({ symbol, exchange }: { symbol: string; exchange: string }) {
  const nav = useNavigate();
  const { data: history = [], isLoading } = useScoreHistory(symbol, exchange, 10);
  const latest = history.length ? history[history.length - 1] : null;
  const { data: sessionInfo } = useLatestPriceSession();
  const fresh = classifyFreshness({
    dataDate: latest?.trade_date,
    latestComplete: sessionInfo?.latestComplete,
    sessions: sessionInfo?.sessions ?? [],
  });

  const rows = buildBucketRows(latest?.buckets, latest?.coverage);
  const earned = rows.reduce((s, r) => s + r.earned, 0);

  return (
    <>
      <div className="hud-label" style={{ fontSize: 9, letterSpacing: "0.14em", color: "var(--accent-soft)", margin: "10px 0 4px" }}>
        {fresh.state === "settled" ? "Latest EOD score" : "Last EOD score"}
      </div>
      {isLoading ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>loading…</div>
      ) : !latest || latest.score == null ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
          No v4 snapshot for {symbol} yet — the nightly aggregates pass writes one per session.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--font-hud)", fontSize: 30, color: "var(--text)", lineHeight: 1 }}>
              {latest.score}
            </span>
            <Chip tone={bandOf(latest.score).tone}>{latest.band ?? bandOf(latest.score).label}</Chip>
            {/* Date only when this snapshot isn't the current settled session. */}
            <span style={{ fontSize: 9, color: fresh.state === "settled" ? "var(--text-muted)" : "var(--warn)" }}
                  title={fresh.title}>
              {fresh.label ?? ""}
              {latest.context_neutral ? `${fresh.label ? " · " : ""}neutral context` : ""}
              {latest.is_liquid_tradable === false ? " · illiquid" : ""}
            </span>
          </div>

          {/* the full 100 in one bar: earned per bucket + everything unearned */}
          <div style={{ display: "flex", height: 8, background: "var(--edge)", marginTop: 8, overflow: "hidden" }}>
            {rows.filter((r) => r.earned > 0).map((r) => (
              <div key={r.key} title={`${r.key} ${r.earned.toFixed(1)} pts`}
                   style={{ width: `${r.earned}%`, height: "100%", background: BUCKET_COLORS[r.key] }} />
            ))}
            <div style={{ flex: 1, background: "repeating-linear-gradient(45deg, var(--edge) 0 3px, transparent 3px 6px)" }} />
          </div>
          <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 3 }}>
            {earned.toFixed(1)} earned · {(100 - earned).toFixed(1)} not earned, out of 100
          </div>

          <div style={{ fontSize: 10, fontFamily: "var(--font-hud)", marginTop: 6 }}>
            {rows.map((r) => (
              <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 6, padding: "1px 0" }}>
                <span style={{ width: 6, height: 6, background: BUCKET_COLORS[r.key], flex: "0 0 auto", opacity: r.present ? 1 : 0.25 }} />
                <span style={{ color: r.present ? "var(--text-dim)" : "var(--text-muted)", flex: "0 0 66px" }}>{r.key}</span>
                <span style={{ flex: 1, height: 3, background: "var(--edge)" }}>
                  <span style={{
                    display: "block", height: "100%",
                    width: `${r.ceiling > 0 ? Math.min(100, (r.earned / r.ceiling) * 100) : 0}%`,
                    background: BUCKET_COLORS[r.key],
                  }} />
                </span>
                <span style={{ flex: "0 0 62px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: r.present ? "var(--text)" : "var(--text-muted)" }}>
                  {r.present ? `${r.earned.toFixed(1)} / ${r.weight}` : r.partial ? "part. data" : "no data"}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <button className="hud-btn" style={{ fontSize: 10, width: "100%", marginTop: 10 }}
              onClick={() => nav(`/market/score/${encodeURIComponent(symbol)}/explain?exchange=${encodeURIComponent(exchange)}`)}>
        More Details →
      </button>
    </>
  );
}

export default ScoreHistoryPanel;
