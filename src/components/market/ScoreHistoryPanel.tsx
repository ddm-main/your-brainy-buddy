// Analysis rail: the EOD vintage of the score as one compact block —
// number + band + a single 100-point distribution. Everything deeper
// (sub-factor maths, penalties, criteria, history, forward returns,
// calibration) lives on /market/score/:symbol/explain.
import { Chip } from "@/components/hud/HudControls";
import { useScoreHistory } from "@/lib/market/scoreHistory";
import { buildBucketRows, bandOf, BUCKET_COLORS, V4_BUCKETS } from "@/lib/market/scoreExplain";
import { useLatestPriceSession } from "@/lib/market/hooks";
import { classifyFreshness } from "@/lib/market/freshness";

/** Current-session score row, used when score history hasn't caught up yet. */
export interface ScoreFallback {
  tradeDate: string | null;
  score: number | null;
  band: string | null;
  components: Record<string, number> | null;
}

/** Derive a bucket-points + coverage pair from the flat v4 components map. */
function fromComponents(components: Record<string, number> | null | undefined) {
  const src = (components ?? {}) as Record<string, unknown>;
  const flat = (src.buckets && typeof src.buckets === "object" ? src.buckets : src) as Record<string, number>;
  const pts: Record<string, number> = {};
  const cov: Record<string, number> = {};
  for (const b of V4_BUCKETS) {
    const v = Number(flat[b.key]);
    if (Number.isFinite(v)) { pts[b.key] = v; cov[b.key] = 1; }
  }
  return { pts, cov, any: Object.keys(pts).length > 0 };
}

export function ScoreHistoryPanel({
  symbol, exchange, fallback,
}: { symbol: string; exchange: string; fallback?: ScoreFallback }) {
  const { data: history = [], isLoading } = useScoreHistory(symbol, exchange, 10);
  const latest = history.length ? history[history.length - 1] : null;
  const { data: sessionInfo } = useLatestPriceSession();

  // The history writer runs behind the scores table; when the score row is for
  // a newer session, show that instead of a stale snapshot.
  const fb = fromComponents(fallback?.components);
  const useFallback =
    !!fallback?.tradeDate && fallback.score != null && fb.any &&
    (!latest || String(fallback.tradeDate) > String(latest.trade_date));

  const dataDate = useFallback ? fallback!.tradeDate! : latest?.trade_date;
  const score = useFallback ? fallback!.score! : latest?.score ?? null;
  const rawBand = useFallback ? fallback!.band : latest?.band;
  const rows = useFallback
    ? buildBucketRows(fb.pts, fb.cov)
    : buildBucketRows(latest?.buckets, latest?.coverage);

  const fresh = classifyFreshness({
    dataDate,
    latestComplete: sessionInfo?.latestComplete,
    sessions: sessionInfo?.sessions ?? [],
  });

  if (isLoading) return <div style={{ fontSize: 11, color: "var(--text-muted)" }}>loading…</div>;
  if (score == null) {
    return (
      <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        No v4 snapshot for {symbol} yet — the nightly aggregates pass writes one per session.
      </div>
    );
  }

  const band = rawBand ?? bandOf(score).label;
  const shown = rows.filter((r) => r.present);
  const dark = rows.filter((r) => !r.present);
  const earned = shown.reduce((s, r) => s + r.earned, 0);

  return (
    <div style={{ marginTop: 8, borderTop: "1px solid var(--edge)", paddingTop: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--font-hud)", fontSize: 20, color: "var(--text)", lineHeight: 1 }}>{score}</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>/ 100</span>
        <Chip tone={bandOf(score).tone}>{band}</Chip>
        <span style={{ fontSize: 9, color: fresh.state === "settled" ? "var(--text-muted)" : "var(--warn)" }} title={fresh.title}>
          EOD{fresh.label ? ` ${fresh.label}` : ""}
        </span>
      </div>

      {/* the full 100 in one bar: earned per bucket + everything unearned */}
      <div style={{ display: "flex", height: 6, background: "var(--edge)", marginTop: 6, overflow: "hidden" }}>
        {shown.filter((r) => r.earned > 0).map((r) => (
          <div key={r.key} title={`${r.key} ${r.earned.toFixed(1)} pts`}
               style={{ width: `${r.earned}%`, height: "100%", background: BUCKET_COLORS[r.key] }} />
        ))}
        <div style={{ flex: 1, background: "repeating-linear-gradient(45deg, var(--edge) 0 3px, transparent 3px 6px)" }} />
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 12,
        fontSize: 10, fontFamily: "var(--font-hud)", marginTop: 6,
      }}>
        {shown.map((r) => (
          <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 5, padding: "1px 0" }}>
            <span style={{ width: 5, height: 5, background: BUCKET_COLORS[r.key], flex: "0 0 auto" }} />
            <span style={{ color: "var(--text-dim)", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{r.key}</span>
            <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text)" }}>
              {r.earned.toFixed(1)}<span style={{ color: "var(--text-muted)" }}>/{r.weight}</span>
            </span>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 4 }}>
        {earned.toFixed(0)} earned{dark.length > 0 ? ` · no data: ${dark.map((r) => r.key).join(", ")}` : ""}
      </div>
    </div>
  );
}

export default ScoreHistoryPanel;
