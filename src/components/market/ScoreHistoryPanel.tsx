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
  /** Per-bucket coverage as written by the scorer (`breakout_v4_coverage`). */
  coverage?: Record<string, number> | null;
}

/**
 * Bucket points from the flat v4 components map.
 *
 * Coverage is deliberately NOT inferred from the points: a dropped bucket is
 * stored as `0`, so treating "has a number" as "was measured" drew
 * `strength 0.0/13` for a bucket that was never scored at all. Real coverage
 * comes from the scorer's own coverage map; when the row predates it we mark
 * only non-zero buckets as covered and leave the zeros as unknown.
 */
function fromComponents(
  components: Record<string, number> | null | undefined,
  coverage: Record<string, number> | null | undefined,
) {
  const src = (components ?? {}) as Record<string, unknown>;
  const flat = (src.buckets && typeof src.buckets === "object" ? src.buckets : src) as Record<string, number>;
  const pts: Record<string, number> = {};
  const cov: Record<string, number> = {};
  const haveCov = !!coverage && Object.keys(coverage).length > 0;
  for (const b of V4_BUCKETS) {
    const v = Number(flat[b.key]);
    if (!Number.isFinite(v)) continue;
    pts[b.key] = v;
    cov[b.key] = haveCov ? Number(coverage![b.key] ?? 0) : (v > 0 ? 1 : 0);
  }
  return { pts, cov, any: Object.keys(pts).length > 0 };
}

/** Stored penalties are kept as `penalty_<name>` on the components blob. */
function penaltiesOf(components: Record<string, number> | null | undefined) {
  const src = (components ?? {}) as Record<string, unknown>;
  const bag = (src.penalties && typeof src.penalties === "object"
    ? src.penalties
    : src) as Record<string, unknown>;
  const out: Array<{ key: string; value: number }> = [];
  for (const [k, v] of Object.entries(bag)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) continue;
    if (k.startsWith("penalty_")) out.push({ key: k.slice(8).replace(/_/g, " "), value: Math.abs(n) });
    else if (src.penalties && typeof src.penalties === "object") out.push({ key: k.replace(/_/g, " "), value: Math.abs(n) });
  }
  return out;
}

export function ScoreHistoryPanel({
  symbol, exchange, fallback,
}: { symbol: string; exchange: string; fallback?: ScoreFallback }) {
  const { data: history = [], isLoading } = useScoreHistory(symbol, exchange, 10);
  const latest = history.length ? history[history.length - 1] : null;
  const { data: sessionInfo } = useLatestPriceSession();

  // The history writer runs behind the scores table; when the score row is for
  // a newer session, show that instead of a stale snapshot.
  const fb = fromComponents(fallback?.components, fallback?.coverage);
  const useFallback =
    !!fallback?.tradeDate && fallback.score != null && fb.any &&
    (!latest || String(fallback.tradeDate) > String(latest.trade_date));

  const dataDate = useFallback ? fallback!.tradeDate! : latest?.trade_date;
  const score = useFallback ? fallback!.score! : latest?.score ?? null;
  const rawBand = useFallback ? fallback!.band : latest?.band;
  const rows = useFallback
    ? buildBucketRows(fb.pts, fb.cov)
    : buildBucketRows(latest?.buckets, latest?.coverage);
  const penalties = useFallback ? penaltiesOf(fallback?.components) : [];

  const fresh = classifyFreshness({
    dataDate,
    latestComplete: sessionInfo?.latestComplete,
    sessions: sessionInfo?.sessions ?? [],
  });

  // A bare "loading…" line collapsed the panel and shifted every row below it
  // on each symbol change — hold the block's height instead.
  if (isLoading) {
    return (
      <div style={{ marginTop: 8, borderTop: "1px solid var(--edge)", paddingTop: 6 }}>
        <div style={{ height: 20, width: 120, background: "var(--edge)", opacity: 0.5 }} />
        <div style={{ height: 6, marginTop: 6, background: "var(--edge)", opacity: 0.5 }} />
        <div style={{ height: 54, marginTop: 6, background: "var(--edge)", opacity: 0.25 }} />
      </div>
    );
  }
  if (score == null) {
    return (
      <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        No v4 snapshot for {symbol} yet — the nightly aggregates pass writes one per session.
      </div>
    );
  }

  const band = (rawBand ?? bandOf(score).label).toUpperCase();
  const shown = rows.filter((r) => r.present);
  const dark = rows.filter((r) => !r.present);
  const earned = shown.reduce((s, r) => s + r.earned, 0);
  const available = shown.reduce((s, r) => s + r.ceiling, 0);
  const whenLabel = dataDate
    ? new Date(`${String(dataDate).slice(0, 10)}T00:00:00`).toLocaleDateString([], { day: "2-digit", month: "short" })
    : null;

  return (
    <div style={{ marginTop: 8, borderTop: "1px solid var(--edge)", paddingTop: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 9, color: "var(--text-muted)", letterSpacing: 0.5 }}>EOD BREAKDOWN</span>
        <span style={{ fontFamily: "var(--font-hud)", fontSize: 20, color: "var(--text)", lineHeight: 1 }}>{score}</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>/ 100</span>
        <Chip tone={bandOf(score).tone}>{band}</Chip>
        <span style={{ fontSize: 9, color: fresh.state === "settled" ? "var(--text-muted)" : "var(--warn)" }} title={fresh.title}>
          {whenLabel ?? "EOD"}{fresh.label ? ` · ${fresh.label}` : ""}
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
          <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 5, padding: "1px 0" }}
               title={`${r.label}: ${r.earned.toFixed(1)} of ${r.ceiling.toFixed(1)} available this session (raw weight ${r.weight}, rescaled because ${dark.length} bucket(s) had no data)`}>
            <span style={{ width: 5, height: 5, background: BUCKET_COLORS[r.key], flex: "0 0 auto" }} />
            <span style={{ color: "var(--text-dim)", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{r.key}</span>
            <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text)" }}>
              {r.earned.toFixed(1)}<span style={{ color: "var(--text-muted)" }}>/{r.ceiling.toFixed(1)}</span>
            </span>
          </div>
        ))}
      </div>

      {penalties.length > 0 && (
        <div style={{ fontSize: 9, color: "var(--warn)", marginTop: 4 }}>
          penalties: {penalties.map((p) => `${p.key} −${p.value.toFixed(1)}`).join(" · ")}
        </div>
      )}

      <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.5 }}>
        {earned.toFixed(1)} earned of {available.toFixed(1)} available
        {" "}· coverage {Math.round(available)}%
        {available < 99.5 && (
          <span title="Buckets with too little data are dropped. Their weight is only partly redistributed (capped at 85% coverage), so this score is measured against a lower ceiling than a fully covered one — it is not directly comparable to a 100-point score.">
            {" "}· ceiling {available.toFixed(0)}/100
          </span>
        )}
        {dark.length > 0 && (
          <> · no data: {dark.map((r) => r.key).join(", ")} <span title="Buckets with too few sub-factors are dropped — they are not scored as zero.">(dropped)</span></>
        )}
        {useFallback && (
          <div style={{ color: "var(--warn)", marginTop: 2 }}>
            snapshot pass behind — showing the live score row, not a stored snapshot
          </div>
        )}
      </div>
    </div>
  );
}

export default ScoreHistoryPanel;
