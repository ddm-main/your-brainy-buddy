# Breakout scoring — bug fixes, pattern removal, swing-trading rework

Checked against the live database (session 2026-08-10, 1,632 scored rows) and the current source.

## What the live data shows

| Check | Result |
|---|---|
| rows carrying a `buckets.sentiment` entry | 1,632 of 1,632 |
| `coverage_share` | exactly 0.91 on every row |
| `patterns` bucket coverage | "covered" on 100% of rows |
| avg raw pattern value | 0.095 (of 1.0) |
| avg pattern points earned | 1.14 of a 12-point bucket |

Two things follow from this, both confirmed rather than assumed:

1. **The deployed scorer is older than the source.** The source weight table has six buckets summing to 100 with no `sentiment`. Yet every stored row still writes a `sentiment` bucket and a coverage share of exactly 0.91 — which is (100 − 9)/100, the old sentiment weight. So the published scores were produced by the previous weight table, and the "duplicate bucket" you see is that ghost: `sentiment` appears once as a zero-point bucket in the breakdown and again as a multiplier in the adjustments panel.
2. **The pattern bucket is close to dead weight.** It is marked covered for the whole universe (single sub-factor, always "present"), but pays an average 1.1 of 12 points. It occupies 12% of the model while behaving as a near-constant, and it is the part you have identified as miscalculating.

## Changes

### 1. Remove the chart-pattern bucket from scoring
- Delete `patterns` from the weight table and from the scorer's rollup; stop reading pattern flags in the scoring path.
- Keep pattern *detection* for the chart UI and the pattern panel — it stops feeding the score, nothing else.
- Keep the bearish-pattern penalty out too, so patterns influence the number in neither direction.
- Redistribute the 12 points explicitly toward what actually decides a swing trade (below), not by silent renormalisation.

### 2. Kill the phantom bucket and the ghost coverage
- Write no `sentiment` key into `buckets`/`coverage`; sentiment stays only as the bounded multiplier it already is.
- A bucket that is genuinely dropped is written as `null`, not `0`, so the explain page can say "not scored" instead of showing a real zero.
- Re-score the latest session after deploy so stored rows stop carrying the old 0.91 coverage.

### 3. New weight table (swing-trading oriented)

| Bucket | Now | New | Why |
|---|---|---|---|
| Levels & trigger | 24 | 26 | Entry quality is the swing edge |
| Volume & participation | 18 | 20 | Confirmation of the move |
| Setups & EMA structure | 14 | 20 | Trend structure is what a multi-week hold rides |
| Relative strength | 14 | 18 | Leadership drives 2–8 week returns |
| Indicators | 18 | 16 | Oscillators are timing, not thesis |
| Chart patterns | 12 | 0 | Removed |

### 4. Fix the incorrect values behind the buckets
- **Breadth is a constant.** `strength.breadth` is 0.5 on the entire universe because the daily regime never reaches the scorer. Wire `market_breadth_daily` into the context and drop the factor when it is genuinely unknown rather than paying everyone a neutral 0.5.
- **Delivery percentage is permanently null** and is silently renormalised away inside the volume bucket — remove the sub-factor and restate the volume sub-weights.
- **Illiquidity is charged twice** (in-bucket zero plus the flat −25 penalty) — keep the penalty, drop the in-bucket zero.
- **Weekly confirmation** currently needs 25 weekly bars and silently disappears below that; make its absence explicit in the breakdown.

### 5. Timeframes, stated on the page
Every factor gets its measurement window written next to it, because today they are only in code comments:

```text
Daily bars, adjusted close
  EMA 20 / 50 / 200        trend structure
  RSI 14, MFI 14, ADX 14   momentum / strength
  MACD 12-26-9             momentum
  ATR 14                   volatility, all ATR distances
  Bollinger 20, 2sd        position in band
  Relative volume          today vs 30-day median
  OBV slope                20 sessions
  Volume dry-up            base window to the last pre-breakout bar
  Pivot / trigger          max(cluster level, 20-day high), 250-day level scan
  Base tightness/depth     the detected consolidation window
  52-week position         252 sessions
  RS vs NIFTY / percentile 55 sessions
  Cross freshness          20/50 and 50/200, searched back 60 sessions
Weekly bars (resampled from daily, minimum 25 weeks)
  EMA 20W, RSI 14W         weekly trend confirmation
```

### 6. "Adjustments & gaps" panel
That heading covers three unrelated things. Split it: **Penalties** (point deductions), **Multipliers** (regime, fundamentals, sentiment). The "gaps" idea — missing-data bookkeeping — moves into the bucket table as a plain "not scored" marker on the affected row. No separate section.

## Other improvements worth making (not in this change unless you say so)

- Add an ATR-based stop and target on the explain page — a swing score without a risk unit is half a decision.
- Add a "days in setup" and expected holding-window read, so the score is time-scoped.
- Coverage-invariant test: a dropped bucket must never raise a score relative to the same input with that bucket at its own average.
- Per-session scoring health row (scored / priced / context-complete) so a regression is visible the day it lands.
- History depth is 21 symbols per session before 2026-07-30; any calibrated cut is noise until that is backfilled.

## Technical notes

- Files: `supabase/functions/_shared/market/v4Weights.ts`, `supabase/functions/_shared/market/scoring.ts`, `supabase/functions/market-pipeline-aggregates/index.ts`, `supabase/functions/market-pipeline-eod/index.ts`, `supabase/functions/market-score-backfill/index.ts`, `supabase/functions/market-screener-asof/index.ts`, `src/lib/market/scoreExplain.ts`, `src/routes/market/ScoreExplain.tsx`, `tests/v4-weights.test.ts`, `tests/marketScoring.test.ts`.
- No schema change. Changing the weights changes every published score, so the weight change and a full re-score of the latest session land together.
