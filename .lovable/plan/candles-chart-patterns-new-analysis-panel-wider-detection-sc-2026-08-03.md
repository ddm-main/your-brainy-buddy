# Candles & Chart Patterns — new Analysis panel, wider detection, score wiring

The pattern engine already exists (`supabase/functions/_shared/market/pattern-series.ts`), the chart already has "Candlestick Patterns" and "Chart Patterns" studies in the indicator registry, and the v4 scorer already has a chart-pattern bucket (weight 11) with a weekly-agreement kicker. What's missing: a dedicated panel on the Analysis page, and most of the pattern bench you listed.

## 1. New panel A4 — "Candles & Patterns"

Inserted directly below Breakout Intelligence (existing A4/A5/A6… reindex by one), following the chart's current timeframe (`tf` state already lives in `Analysis.tsx`, so the panel reads the same candles the chart draws — 1m through 1M, no extra fetch).

Contents, compact HUD rows:

- Header chip: current timeframe + bar count used.
- **Candlesticks (last N bars)** — chips for every candle pattern detected on the most recent bars, newest first, tone-coloured (bullish green / bearish red / neutral amber), each showing how many bars ago it printed.
- **Structures** — chips for active multi-bar patterns (triangles, flags, wedges, H&S, double/triple tops, cup, rectangle, channels), each with its breakout level and a `triggered` / `forming` state.
- **Market structure** — current HH/HL/LH/LL read, last BOS / CHOCH, unfilled FVGs, latest liquidity sweep.
- **Confluence line** — one summary read: net bullish vs bearish weight on this timeframe, plus agreement with the daily and weekly readings.
- Two toggles that drive the chart above: "Mark candles" and "Draw structures" — they add/remove the existing `candlePatterns` / `chartPatterns` studies, so patterns get plotted on the chart at any timeframe.

Clicking any chip scrolls/zooms the chart to that pattern's bars.

## 2. Detection scope added to the engine

Existing: engulfing, harami, piercing/dark cloud, morning/evening star, 3 soldiers/crows, hammer family, doji family, tweezers, marubozu; cup & handle, ascending/descending triangle, bull flag, double bottom/top, inv. H&S, H&S, rising/falling wedge.

New in this build:

- **Reversal**: triple top, triple bottom, rounded top, rounded bottom, inverse cup & handle.
- **Continuation**: bear flag, bull/bear pennant, symmetrical triangle, rectangle.
- **Channels**: ascending, descending, horizontal, broadening formation.
- **Candlestick**: spinning top, three inside up/down, three outside up/down, rising/falling three methods, tasuki gap, mat hold.
- **Gaps**: gap up/down, breakaway, runaway, exhaustion, common.
- **Bars/volatility**: inside bar, outside bar, NR4, NR7, Bollinger squeeze, opening-range breakout (intraday only), volatility breakout.
- **Volume**: volume breakout, climax, dry-up, accumulation, distribution.
- **Trend/MA**: golden cross, death cross, MA bounce, trendline break/retest, support bounce, resistance rejection.
- **Market structure (SMC)**: HH/HL/LH/LL swing labelling, break of structure, change of character, liquidity sweep, order block, fair value gap, breaker/mitigation block.
- **Wyckoff (light)**: accumulation / distribution range with spring and upthrust detection.

Not in this build: harmonic patterns (Gartley/Butterfly/Bat/Crab/Shark/Cypher/AB=CD) and Elliott wave counts — per your scope choice.

Every detector stays ATR-scaled / bar-count based so it is valid on any timeframe, and every new pattern gets a registry entry (label, tone, blurb, weight) in `src/lib/market/patternLabels.ts` so the chips, the chart labels and the score explainer all read from one table.

## 3. Breakout score wiring (bucket 6 only, total stays 100)

- `breakoutPatternBonus` gains the new keys: bullish structures and confirmations add to the existing capped bonus, bearish ones (triple top, bear flag/pennant, distribution, CHOCH down, exhaustion gap) go through the existing bearish-penalty path.
- Market-structure and volume reads act as **confirmation multipliers** inside the bucket rather than new weight: BOS-up + volume breakout amplifies an existing bullish structure; CHOCH-down damps it.
- The weekly-agreement term already in bucket 6 is extended to the new keys.
- Bucket cap and the 11-point weight are unchanged, so historical scores stay comparable; `tests/v4-weights.test.ts` gets an assertion that the total still tops out at 100.

## Technical notes

- Files: `supabase/functions/_shared/market/pattern-series.ts` (split into `pattern-series.ts` + new `pattern-structure.ts` for SMC/Wyckoff/volume so neither file gets unwieldy), `scoring.ts`, `src/lib/market/patternLabels.ts`, `src/lib/market/indicatorRegistry.ts`, `src/components/market/CandleChart.tsx`, new `src/components/market/PatternPanel.tsx`, `src/routes/market/Analysis.tsx`.
- Detection is memoised per candle array (existing `studyCache` WeakMap), and the panel reuses the chart's already-fetched candles — no new network calls, no new tables, no migration. Pattern flags continue to persist in `market_stock_scores.pattern_flags` (JSON, new keys need no schema change).
- Tests: extend `tests/patternSeries.test.ts` with synthetic series for each new pattern family, plus `tests/v4-weights.test.ts` for the score cap.
