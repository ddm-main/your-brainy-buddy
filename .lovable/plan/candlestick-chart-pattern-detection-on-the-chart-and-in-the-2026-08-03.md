# Candlestick + chart pattern detection on the chart, and in the breakout score

Today pattern detection exists only as a single end-of-series verdict: `detectPatterns()` in `supabase/functions/_shared/market/indicators-advanced.ts` returns twelve booleans for the **last bar of the daily series**, the EOD pipeline stores them in `market_scores.pattern_flags`, the Analysis page lists them as chips, and the v4 scorer uses them in bucket 6. Nothing is drawn on the chart, and nothing runs on intraday or weekly timeframes.

This plan turns detection into a per-bar series, plots it on the chart at any timeframe, and feeds the chart-timeframe reading back into the breakout score.

## 1. Per-bar pattern engine (shared)

New shared module `supabase/functions/_shared/market/pattern-series.ts`:

- `detectPatternsAt(candles, endIndex)` — the existing `detectPatterns` logic refactored to evaluate any bar, not just the last one. All thresholds stay ATR-scaled and bar-count based, so the same code is valid on 1m through monthly.
- `detectPatternSeries(candles)` — walks every bar and returns:
  - `candles[i]: CandleFlag[]` — single/two/three-bar candlestick reads.
  - `shapes: ChartShape[]` — multi-bar structures with their geometry (start/end bar index, rim/neckline/trendline points, breakout level, `triggered` boolean).
- Candlestick set extended beyond today's five to the standard bench: bullish/bearish engulfing, hammer, inverted hammer, shooting star, hanging man, doji (+dragonfly/gravestone), harami, piercing line, dark cloud cover, morning/evening star, three white soldiers / three black crows, tweezer top/bottom, marubozu.
- Chart-pattern set: today's cup & handle (+triggered), ascending/descending triangle, bull/bear flag, double bottom/top, inverse head & shoulders (+H&S), falling/rising wedge, plus horizontal channel.
- `detectPatterns()` keeps its current signature and becomes a thin wrapper over `detectPatternsAt(candles, n-1)` so the EOD pipeline, `market-score-backfill`, `market-screener-asof` and `liveSnapshot.ts` keep working unchanged.

## 2. Two new chart studies

Added to `INDICATOR_DEFS` in `src/lib/market/indicatorRegistry.ts`, both `group: "overlay"`, so they appear in the indicator picker the same way EMA/Volume do:

- **Candlestick Patterns** — params: `bullish` (0/1), `bearish` (0/1), `neutral` (0/1), `minBody` sensitivity. Renders a marker above/below each qualifying bar (up triangle bullish, down triangle bearish, circle neutral) with a short label; the marker tooltip carries the full pattern name.
- **Chart Patterns** — params: `lookback` bars, `minBars`, `showPending` (0/1). Renders each detected structure's geometry as dashed overlay lines (rims, neckline, trendlines) plus a labelled marker at the breakout bar, coloured by bullish/bearish and dimmed while un-triggered.

`CandleChart.tsx` gets two new `computeStudy` branches (`g: "patternMarkers"`, `g: "patternShapes"`) and two render branches in the overlay loop, reusing the existing `createSeriesMarkers` plugin path (already used by Supertrend) and `overlayLine`. Both are pushed into the same `markersPlugins` / cleanup arrays so nothing leaks. `ChartLegend` shows the count of patterns currently in view.

Because computation runs on whatever candle array the chart holds, it works on every timeframe (1m, 5m, 15m, 1h, 1d, 1w) with no extra plumbing.

## 3. Breakout score wiring

- The EOD pipeline keeps scoring the **daily** reading exactly as it does now (no score drift from this change) but additionally computes the pattern set on **weekly** candles and passes a `patternsWeekly` input into `breakoutScoreV4`.
- Bucket 6 ("Chart patterns", weight 11) gains a multi-timeframe agreement term: when a bullish daily pattern is confirmed by a bullish weekly structure, the bucket's normalised value gets a bounded uplift; a bearish weekly read damps it. The bucket's existing coverage gate (`barsAvailable >= 60`) is unchanged, and the extra term abstains when weekly history is short — so nothing changes for stocks without the data.
- Newly detected structures (double top, H&S, rising wedge, three black crows) join the existing bearish penalty path rather than adding new score weight, keeping the total at 100.
- `src/lib/market/liveSnapshot.ts` switches to the same series detector so the live recompute and the stored score stay identical by construction.
- `src/lib/market/patternLabels.ts` gains registry entries (label, tone, blurb, weight) for every new pattern key, so the Analysis chips and score explainer pick them up automatically.

## 4. Persistence

Pattern flags already live in `market_scores.pattern_flags` (a JSON map), so the new keys need no migration. The weekly reading is stored under the same JSON as `w_*`-prefixed keys.

## Technical notes

- Files touched: new `supabase/functions/_shared/market/pattern-series.ts`; edits to `indicators-advanced.ts`, `scoring.ts`, `market-pipeline-eod/index.ts`, `src/lib/market/indicatorRegistry.ts`, `src/components/market/CandleChart.tsx`, `src/components/market/ChartLegend.tsx`, `src/lib/market/patternLabels.ts`, `src/lib/market/liveSnapshot.ts`.
- Tests: extend `tests/marketIndicators.test.ts` with synthetic series for each new candlestick pattern, and `tests/v4-weights.test.ts` to assert the score still tops out at 100 with the weekly-agreement term active.
- Detection is memoised through the existing `studyCache` WeakMap keyed on the candle array, so panning/zooming does not re-run the scan.
