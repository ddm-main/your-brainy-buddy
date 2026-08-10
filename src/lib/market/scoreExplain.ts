// The v4 scoring catalog, mirrored from supabase/functions/_shared/market/scoring.ts.
//
// The scorer stores its work in market_stock_scores.breakout_v4_components as
// { buckets, factors, penalties }: `buckets` are the points each bucket
// contributed AFTER renormalisation, `factors` are the raw 0..1 sub-factor
// values keyed `<bucket>.<factor>`, `penalties` are point deductions.
//
// This module turns that into something a human can read: raw weight vs
// renormalised ceiling vs earned, and one plain sentence per sub-factor
// saying why it scored what it scored.

export const BUCKET_MIN_COVERAGE = 0.35;
/** Mirrors V4_FULL_RENORM_COVERAGE in the scorer — see tests/v4-weights.test.ts. */
export const V4_FULL_RENORM_COVERAGE = 0.85;

export interface FactorSpec {
  key: string;
  /** share of the bucket, 0..1 */
  w: number;
  label: string;
  /** measurement window — the timeframe this factor is computed on */
  tf?: string;
  /** what the sub-factor measures */
  what: string;
  /** what a 1.0 looks like */
  full: string;
}

export interface BucketSpec {
  key: string;
  label: string;
  weight: number;
  blurb: string;
  factors: FactorSpec[];
}

/**
 * Timeframe contract for the whole model — every number below is computed on
 * daily adjusted bars unless the factor says otherwise, and the one weekly
 * input is resampled from those same daily bars (minimum 25 weeks).
 */
export const TIMEFRAME_NOTE =
  "All factors are computed on daily adjusted bars. The weekly trend factor resamples those same daily bars and needs at least 25 weekly bars to score at all.";

/** Buckets in fixed raw-weight order — never sorted by points, so rows don't
 *  reshuffle between sessions. Weights sum to 100.
 *
 *  2026-08-10: the chart-pattern bucket was removed from the model (it reported
 *  full coverage on every row while paying ~1.1 of 12 points) and its weight
 *  redistributed toward the factors that decide a multi-week swing. */
export const V4_BUCKETS: BucketSpec[] = [
  {
    key: "levels",
    label: "Levels & trigger",
    weight: 26,

    blurb: "Where price sits against its pivot, and the quality of the base underneath it.",
    factors: [
      { key: "trigger", w: 0.45, label: "Trigger", tf: "daily · pivot = max(level cluster, 20-day high), levels scanned over 250 sessions; distance in ATR(14)", what: "How far the close is above the pivot, in ATRs, scaled by how many volume-weighted touches the level has and where the bar closed in its range.", full: "Close a full ATR or more above a well-touched pivot, closing in the top third of the bar. A close below the pivot earns at most 45% partial credit, decaying to nothing 1.5 ATR below." },
      { key: "freshness", w: 0.10, label: "Freshness", tf: "daily · 20-day breakout, 10-session state window", what: "Sessions since the breakout print.", full: "Breakout happened today; zero after 5 sessions, and zero outright when there is no live breakout or the last one failed." },
      { key: "base_tightness", w: 0.15, label: "Base tightness", tf: "daily · the detected consolidation window", what: "Width of the consolidation before the move.", full: "Base range at or under 2% of price; nothing at 8%+." },
      { key: "base_depth", w: 0.10, label: "Base depth", tf: "daily · the detected consolidation window", what: "Peak-to-trough drawdown inside the base.", full: "8% or shallower; nothing at 30%+." },
      { key: "base_duration", w: 0.10, label: "Base duration", tf: "daily · sessions in the base", what: "How long the base has been building.", full: "30 sessions or more; nothing under 10." },
      { key: "support_defence", w: 0.10, label: "Support defence", tf: "daily · 250-session support scan, distance in ATR(14)", what: "How close price sits to a real, non-fallback support.", full: "Close within half an ATR of a genuine support level; fades to zero by 3 ATR, and is not scored at all when the only 'support' is the lookback low." },
    ],
  },
  {
    key: "volume",
    label: "Volume & participation",
    weight: 20,
    blurb: "Is real money behind the move, or is it a thin drift?",
    factors: [
      { key: "rel_volume_30d", w: 0.55, label: "Relative volume", tf: "daily · today vs the 30-day median (or the size-tier percentile)", what: "Today's volume against its normal. Dropped — not zeroed — when turnover is below the liquidity floor or unknown, because illiquidity is already charged as a penalty.", full: "3x the 30-day median, or the 95th percentile within its market-cap tier." },
      { key: "obv_slope", w: 0.25, label: "OBV slope", tf: "daily · 20-session slope", what: "On-balance-volume trend — accumulation vs distribution.", full: "Strongly rising OBV." },
      { key: "vol_dryup", w: 0.20, label: "Volume dry-up", tf: "daily · base window, measured to the last pre-breakout bar", what: "Volume contraction into the base, so the breakout's own expansion doesn't cancel it.", full: "Base volume at 60% of normal or less." },
    ],

  },
  {
    key: "setups",
    label: "Setups & EMA structure",
    weight: 20,

    blurb: "Is the trend structure underneath the trade actually intact? This is what a multi-week hold rides.",
    factors: [
      { key: "ema_alignment", w: 0.30, label: "EMA alignment", tf: "daily · EMA 20 / 50 / 200", what: "20 > 50 > 200 stacking.", full: "Fully aligned; 0.5 when only 20 > 50." },
      { key: "above_ema200", w: 0.25, label: "Above 200 EMA", tf: "daily · EMA 200", what: "The long-term regime filter.", full: "Close above the 200 EMA (binary)." },
      { key: "cross_20_50", w: 0.15, label: "20/50 cross", tf: "daily · cross searched back 60 sessions, decays over 25", what: "Freshness of the 20/50 EMA cross up.", full: "Crossed today; decays to zero over 25 sessions." },
      { key: "cross_50_200", w: 0.10, label: "50/200 cross", tf: "daily · cross searched back 60 sessions, decays over 25", what: "Freshness of the golden cross.", full: "Crossed today; decays to zero over 25 sessions." },
      { key: "weekly_trend", w: 0.20, label: "Weekly trend", tf: "weekly (resampled, min 25 bars) · EMA 20W, RSI 14W", what: "Above the 20-week EMA (0.5), weekly trend up (0.3), weekly higher lows (0.2). Not scored at all with under 25 weekly bars.", full: "All three true on the weekly chart." },
    ],
  },
  {
    key: "strength",
    label: "Relative strength",
    weight: 18,
    blurb: "Is this stock leading the market and its sector, or being carried by them?",
    factors: [
      { key: "pos_52w", w: 0.25, label: "Position in 52w range", tf: "daily · 252 sessions", what: "Distance from the 52-week high.", full: "Within 1% of the 52-week high; nothing at −35%." },
      { key: "rel_strength", w: 0.25, label: "RS vs NIFTY", tf: "daily · 55 sessions vs the index", what: "Outperformance against the index.", full: "+15% or better against NIFTY; nothing at −5%." },
      { key: "rs_percentile", w: 0.20, label: "RS percentile", tf: "daily · rank of the 55-session RS across the universe", what: "Rank of that relative strength inside the universe.", full: "90th percentile; nothing at the 50th." },
      { key: "sector_strength", w: 0.20, label: "Sector strength", tf: "daily · sector aggregate for the session", what: "How the stock's sector is performing. Dropped when sector ranking is unavailable rather than assumed average.", full: "Sector at the top of the tape." },
      { key: "breadth", w: 0.10, label: "Market regime", tf: "daily · universe share above EMA 50 blended with average RSI(14)", what: "Graded reading of the tape. Dropped when breadth is unavailable — it is no longer paid as a flat 0.5 to everyone.", full: "Broad participation (75%+ above the 50 EMA) with average RSI above 62." },
    ],
  },
  {
    key: "indicators",
    label: "Indicators",
    weight: 16,

    blurb: "Momentum and volatility timing reads, each capped so no single one dominates.",
    factors: [
      { key: "rsi", w: 0.25, label: "RSI (14)", tf: "daily · 14 sessions", what: "Momentum, scored as a window rather than 'higher is better'.", full: "RSI between 60 and 75. Below 40 and above 85 both score zero." },
      { key: "macd", w: 0.20, label: "MACD", tf: "daily · 12-26-9", what: "MACD above signal (0.6) plus a rising histogram (0.4). When histogram history is missing, the cross alone carries the factor instead of being marked down.", full: "Above signal with a rising histogram." },
      { key: "adx", w: 0.20, label: "ADX (14)", tf: "daily · 14 sessions", what: "Trend strength.", full: "ADX 30+; nothing at 15 or below." },
      { key: "atr_pct", w: 0.10, label: "ATR %", tf: "daily · ATR(14) as a share of price", what: "Volatility sanity — too quiet cannot travel, too wild cannot be held.", full: "2–6% daily ATR, or mid-range volatility for its size tier." },
      { key: "percent_b", w: 0.10, label: "Bollinger %B", tf: "daily · 20 sessions, 2 standard deviations", what: "Position inside the Bollinger band, capped at the upper band — riding beyond it is overextension, charged as a penalty instead.", full: "At the upper band." },
      { key: "mfi", w: 0.10, label: "MFI (14)", tf: "daily · 14 sessions", what: "Money-flow index — volume-weighted momentum.", full: "MFI 80+; nothing at 50 or below." },
      { key: "supertrend", w: 0.05, label: "Supertrend", tf: "daily · ATR(10), factor 3", what: "Supertrend direction.", full: "Direction is up (binary)." },
    ],
  },
];


/** Fundamentals are a multiplier (0.90–1.05), never points. */
export const FUNDAMENTAL_FACTORS: FactorSpec[] = [
  { key: "revenue_growth", w: 0.20, label: "Revenue growth", what: "YoY revenue growth.", full: "25%+ YoY." },
  { key: "profit_growth", w: 0.20, label: "Profit growth", what: "YoY profit growth.", full: "30%+ YoY." },
  { key: "roe", w: 0.25, label: "ROE", what: "Return on equity.", full: "25%+; nothing at 8%." },
  { key: "debt_equity", w: 0.20, label: "Debt / equity", what: "Balance-sheet leverage (lower is better).", full: "0.5x or less; nothing at 2x." },
  { key: "promoter_holding", w: 0.10, label: "Promoter holding", what: "Promoter stake.", full: "55%+; nothing at 25%." },
  { key: "valuation", w: 0.05, label: "Valuation", what: "Trailing PE (lower is better, negative earnings score zero).", full: "PE at or under 40; nothing at 90+." },
];

export const FUNDAMENTAL_MULT_MIN = 0.9;
export const FUNDAMENTAL_MULT_MAX = 1.05;

/** Sentiment is a narrow multiplier (0.95–1.03), never points: news and AI
 *  coverage exist on a tiny minority of rows, so as a bucket its weight was
 *  renormalised away — and quietly inflated — on everything else. */
export const SENTIMENT_FACTORS: FactorSpec[] = [
  { key: "ai_verdict", w: 0.55, label: "AI verdict", what: "The stored AI recommendation, pulled toward neutral by its own confidence.", full: "A high-confidence strong buy." },
  { key: "news_sentiment", w: 0.45, label: "News sentiment", what: "Average sentiment over the recent news window, shrunk toward neutral when only one or two articles back it. Dropped when there is no news.", full: "Uniformly positive coverage across 5+ articles." },
];

export const SENTIMENT_MULT_MIN = 0.95;
export const SENTIMENT_MULT_MAX = 1.03;


export const PENALTY_LABELS: Record<string, { label: string; why: string }> = {
  overextension: { label: "Overextended", why: "Close is 3+ ATR above the 20 EMA — the easy move is already gone and pullback risk dominates." },
  thin_volume: { label: "Thin volume", why: "Volume is below 80% of its 30-day median: the move has no participation behind it." },
  overbought: { label: "Overbought", why: "RSI above 80 — entries here take the worst of the mean reversion." },
  bearish_pattern: { label: "Bearish pattern", why: "A bearish formation was detected on the chart and charged against the setup." },
  failed_breakout: { label: "Failed breakout", why: "Price triggered within the last 10 sessions and has since fallen back inside the base. A failure is strictly worse than never having triggered; the deeper the re-entry, the bigger the charge." },
  illiquid: { label: "Illiquid", why: "The symbol fails the liquidity gate (turnover / traded value floor) — it is not tradable at size." },
  event_blackout: { label: "Event blackout", why: "Results or an ex-date land within two sessions, so a binary event decides the next print. The score is hard-capped into the WATCH band rather than merely shaved." },
};

export interface BucketRow {
  key: string;
  label: string;
  weight: number;
  /** renormalised ceiling for this session, 0 when the bucket was dropped */
  ceiling: number;
  earned: number;
  coverage: number;
  present: boolean;
  /** covered a little, but below the 0.35 threshold, so it was dropped */
  partial: boolean;
}

/** Raw weight, renormalised ceiling and earned points per bucket. */
export function buildBucketRows(
  buckets: Record<string, number> | null | undefined,
  coverage: Record<string, number> | null | undefined,
): BucketRow[] {
  const cov = coverage ?? {};
  // Some stored snapshots (a bad write on 2026-08-03) put the whole components
  // envelope `{buckets, factors, penalties}` in the `buckets` column. Unwrap it
  // so those rows read as points instead of a column of 0.0.
  const rawPts = (buckets ?? {}) as Record<string, unknown>;
  const pts = (rawPts.buckets && typeof rawPts.buckets === "object"
    ? rawPts.buckets
    : rawPts) as Record<string, number>;
  const present = V4_BUCKETS.filter((b) => Number(cov[b.key] ?? 0) >= BUCKET_MIN_COVERAGE);
  const presentW = present.reduce((s, b) => s + b.weight, 0);
  // Mirror the scorer: renormalisation is capped at V4_FULL_RENORM_COVERAGE, so
  // the ceilings shown here sum to the score's real ceiling (which can be well
  // under 100) rather than always to 100.
  const scale = presentW > 0 ? Math.min(100 / presentW, 1 / V4_FULL_RENORM_COVERAGE) : 0;
  return V4_BUCKETS.map((b) => {
    const c = Number(cov[b.key] ?? 0);
    const isPresent = c >= BUCKET_MIN_COVERAGE;
    return {
      key: b.key,
      label: b.label,
      weight: b.weight,
      ceiling: isPresent ? Math.round(b.weight * scale * 10) / 10 : 0,
      earned: Number(pts[b.key] ?? 0),
      coverage: c,
      present: isPresent,
      partial: !isPresent && c > 0,
    };
  });
}

/** Pull the `<bucket>.<factor>` sub-values out of the stored factors map. */
export function factorsFor(
  bucket: string,
  factors: Record<string, number> | null | undefined,
): Array<{ spec: FactorSpec; value: number | null }> {
  const spec = V4_BUCKETS.find((b) => b.key === bucket);
  if (!spec) return [];
  const f = factors ?? {};
  return spec.factors.map((s) => {
    const raw = f[`${bucket}.${s.key}`];
    return { spec: s, value: raw == null || Number.isNaN(Number(raw)) ? null : Number(raw) };
  });
}

/** How the 0..1 value reads in words. */
export function verdictOf(v: number | null): { word: string; tone: "ok" | "warn" | "err" | "dim" } {
  if (v == null) return { word: "no data", tone: "dim" };
  if (v >= 0.85) return { word: "full credit", tone: "ok" };
  if (v >= 0.6) return { word: "strong", tone: "ok" };
  if (v >= 0.35) return { word: "partial", tone: "warn" };
  if (v > 0.05) return { word: "weak", tone: "err" };
  return { word: "no credit", tone: "err" };
}

/**
 * Points a sub-factor contributed to the bucket. The scorer renormalises
 * within the bucket over the factors that had data, so a factor's share is its
 * weight over the weight of the present factors.
 */
export function factorPoints(
  rows: Array<{ spec: FactorSpec; value: number | null }>,
  bucketEarned: number,
): Array<{ spec: FactorSpec; value: number | null; share: number; points: number }> {
  const haveW = rows.reduce((s, r) => s + (r.value == null ? 0 : r.spec.w), 0);
  const acc = rows.reduce((s, r) => s + (r.value == null ? 0 : r.value * r.spec.w), 0);
  return rows.map((r) => {
    const share = haveW > 0 && r.value != null ? r.spec.w / haveW : 0;
    const points = acc > 0 && r.value != null ? (r.value * r.spec.w / acc) * bucketEarned : 0;
    return { ...r, share, points };
  });
}

/** One-sentence summary of the bucket, naming the biggest winner and loser. */
export function bucketSentence(
  bucket: BucketRow,
  rows: Array<{ spec: FactorSpec; value: number | null; share: number; points: number }>,
): string {
  if (!bucket.present) {
    return bucket.partial
      ? `Dropped: only ${Math.round(bucket.coverage * 100)}% of this bucket's sub-factors had data, below the ${Math.round(BUCKET_MIN_COVERAGE * 100)}% minimum, so its ${bucket.weight} raw points were partly redistributed across the buckets that did have data — redistribution is capped at ${Math.round(V4_FULL_RENORM_COVERAGE * 100)}% coverage, so the rest simply lowers this score's ceiling.`
      : `No inputs at all for this bucket. Its ${bucket.weight} raw points are only partly redistributed (capped at ${Math.round(V4_FULL_RENORM_COVERAGE * 100)}% coverage); the remainder lowers the ceiling this score is measured against.`;
  }
  const have = rows.filter((r) => r.value != null);
  if (!have.length) return "Covered, but no sub-factor values were recorded.";
  const sorted = [...have].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const pct = bucket.ceiling > 0 ? Math.round((bucket.earned / bucket.ceiling) * 100) : 0;
  const lost = have
    .filter((r) => (r.value ?? 1) < 0.35)
    .sort((a, b) => b.share - a.share)[0];
  let s = `Earned ${bucket.earned.toFixed(1)} of ${bucket.ceiling.toFixed(1)} (${pct}% of what was available). `;
  s += `${best.spec.label} carried it at ${(best.value ?? 0).toFixed(2)}`;
  if (lost && lost.spec.key !== best.spec.key) {
    s += `, while ${lost.spec.label} scored ${(lost.value ?? 0).toFixed(2)} — worth ${Math.round(lost.share * 100)}% of this bucket, so that alone cost roughly ${(lost.share * bucket.ceiling * (1 - (lost.value ?? 0))).toFixed(1)} points.`;
  } else if (worst.spec.key !== best.spec.key) {
    s += `, with ${worst.spec.label} the weakest at ${(worst.value ?? 0).toFixed(2)}.`;
  } else {
    s += ".";
  }
  const missing = rows.filter((r) => r.value == null);
  if (missing.length) {
    s += ` ${missing.map((m) => m.spec.label).join(", ")} had no data and ${missing.length === 1 ? "was" : "were"} renormalised away inside the bucket.`;
  }
  return s;
}

export function bandOf(v: number): { label: string; tone: "ok" | "warn" | "err" | undefined } {
  if (v >= 70) return { label: "STRONG", tone: "ok" };
  if (v >= 55) return { label: "MODERATE", tone: undefined };
  if (v >= 40) return { label: "WATCH", tone: "warn" };
  return { label: "WEAK", tone: "err" };
}

/** Stable colour per bucket for the stacked distribution bar. */
export const BUCKET_COLORS: Record<string, string> = {
  levels: "var(--accent)",
  volume: "#4fb3a5",
  indicators: "#7aa2f7",
  setups: "#c08cf0",
  strength: "#e0af68",
};
