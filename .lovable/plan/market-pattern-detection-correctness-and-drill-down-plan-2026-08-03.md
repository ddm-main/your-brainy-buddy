# Market Pattern Detection — Correctness and Drill-down Plan

## Goal

Make candlestick and chart-pattern results trustworthy, explainable, and useful when clicked. Every visible result should identify the exact candles, rules, levels, confirmation state, and invalidation condition that produced it.

## Confirmed problems

- **Every non-cup chart shape is labelled `triggered`** even when the detector only found loose geometry. The scanner currently sets `triggered: true` for all other structures.
- **Rectangle and horizontal channel are duplicates.** Both use the same flat-high/flat-low rule, so one range can appear twice.
- **Wyckoff labels overstate the evidence.** “Wyckoff accumulation/distribution” are currently direct aliases of a 20-bar money-flow threshold, without the phase, test, spring/upthrust, or confirmation expected from that label.
- **Shape geometry is not the detected geometry.** Start dates are inferred from a fixed nominal bar count, and the displayed “level” is just the window extreme. Persistent detections can then stretch far beyond the actual setup.
- **The chart and EOD scorer can disagree.** Single-candle rules are implemented separately in `candleMarksAt` and `detectPatterns`, including different hammer/wick rules.
- **Forming candles can create unstable intraday results.** The chart scan receives the live, incomplete bar even though the scorer documents completed-bar behavior.
- **The current click path does nothing.** Pattern rows are static; chart markers cannot open evidence or focus the relevant candles.
- **Testing is far below the detector surface.** Most structures, volume patterns, Wyckoff logic, SMC events, boundaries, invalidation, mutual exclusion, and 5m/weekly behavior have no direct tests.

## Build plan

### 1. Repair the shared detection model

- Replace the boolean-only chart-shape output with an explainable result while preserving the existing flags needed by scoring:
  - pattern key, tone, timeframe and status: `forming`, `confirmed`, `triggered`, or `invalidated`;
  - exact start, completion and trigger candle indexes;
  - upper/lower boundary, neckline or breakout level as applicable;
  - breakout direction, confidence, and distance from trigger level;
  - compact evidence values such as touches, slopes, depth, ATR tolerance, volume ratio and money-flow value;
  - a plain formula/rule and explicit confirmation/invalidation conditions.
- Use actual pivots/touches to establish shape boundaries instead of fixed lookback-derived dates and raw window extremes.
- Make shape families mutually exclusive where they describe the same geometry:
  - rectangle versus horizontal channel;
  - triangle versus wedge/channel;
  - accumulation versus distribution;
  - bullish versus bearish state variants.
- Stop emitting generic “triggered” states. A trigger requires a completed close through the correct boundary with an ATR-scaled buffer; otherwise the result stays forming/confirmed.
- Expire or invalidate stale shapes when price breaks the opposite boundary or the setup ages out.

### 2. Correct the weakest detectors

- **Ranges/channels/rectangles:** require meaningful pivot touches on both boundaries, stable width, slope-fit quality, and a minimum duration. Emit one canonical range result, not two labels for the same candles.
- **Wyckoff:** keep generic accumulation/distribution as volume-flow context, but only show a Wyckoff structure when range maturity plus phase evidence exists. A spring/upthrust must undercut/overcut the prior range and reclaim/reject it on a later completed candle. Never show simultaneous accumulation and distribution for one detection window.
- **Tops/bottoms/H&S/triangles/wedges:** use ordered pivots, minimum separation, ATR-scaled similarity, neckline/boundary confirmation, and explicit invalidation.
- **Candlesticks:** move shared geometry into one implementation so chart markers and EOD pattern flags use identical definitions. Keep trend context for names such as hammer versus hanging man and shooting star versus inverted hammer.
- **Market structure:** ensure BOS/CHOCH compares the close to a prior confirmed swing, not a swing that can include the current bar.
- Scan only completed bars for actionable pattern states. The forming bar may be shown as “developing” but must not be scored or marked triggered.

### 3. Add a real click-through pattern detail experience

- Make every Candlesticks and Structures row in `PatternPanel` clickable using the existing design-system controls.
- Add a wide, compact pattern-detail dialog containing:
  - pattern, timeframe, direction, confidence and status;
  - detected/completed/triggered timestamps and bars-ago;
  - the exact relevant candle table: time, O/H/L/C, body, upper/lower wick, range, volume and relative volume;
  - structure measurements: start/end, duration, upper/lower/neckline, touches, ATR tolerance, slopes/depth and breakout distance;
  - `Detected because` with the actual substituted calculation, not generic prose;
  - `Confirms above/below` and `Invalid below/above` levels;
  - data-source and completed/forming-bar status.
- Add “Focus on chart” so the chart zooms to the pattern window with a small context margin.
- Allow chart pattern markers to select the same result where the chart library exposes marker click data; panel-row click remains the reliable path.
- Highlight the selected candles and boundaries on the chart, and clear the highlight when the dialog closes.

### 4. Remove duplicated and misleading presentation

- Use the detailed shared detector for the A4 panel and chart overlays.
- Keep A5 as the daily score summary, but make its pattern chips open the corresponding daily evidence instead of showing unexplained flags.
- Replace vague counts such as `bullish 8 / bearish 5` with current confirmed/triggered counts; neutral informational bars must not influence directional bias.
- Show compact status labels (`forming`, `confirmed`, `triggered`) and confidence. Do not call a result triggered merely because its geometry remains true.
- Deduplicate overlapping detections by key, family, window overlap and level proximity; retain the higher-confidence/latest result.

### 5. Validation and regression coverage

- Add deterministic positive, near-miss and invalidation fixtures for every chart-pattern family and the scored candlestick set.
- Add boundary tests for ATR/percentage thresholds and mutual-exclusion tests for conflicting patterns.
- Add stale-shape tests: trigger, invalidate, expire, then re-form as a new detection rather than extending the old one.
- Run the same representative fixtures at 5m, daily and weekly timestamps; verify no look-ahead and no forming-bar trigger.
- Add UI tests for row click, evidence calculations, focus range, and A4/A5 consistency.
- Reproduce the currently misleading case and verify it no longer shows simultaneous Wyckoff accumulation/distribution, duplicate rectangle/channel results, or false triggered labels.

## Technical scope

- Shared engine: `pattern-series.ts`, `pattern-structure.ts`, and the candlestick portion of `indicators-advanced.ts`.
- UI: `PatternPanel.tsx`, `CandleChart.tsx`, `Analysis.tsx`, plus a focused pattern-detail component.
- Labels/types: `patternLabels.ts` and chart-study result types.
- Tests: expand `patternSeries.test.ts` and add focused detector/detail tests.
- No new database tables or migrations are required. Existing `pattern_flags` remain compatible; richer evidence is computed from the loaded candle series.

## Completion criteria

- Clicking any visible result explains the exact candles and substituted rule that produced it.
- A pattern cannot be both forming and triggered, and duplicate/conflicting structures are suppressed.
- A4, chart overlays, and daily A5 flags use the same core rules and clearly state their timeframe.
- Intraday actionable results use completed candles only.
- The known incorrect pattern case is reproducible in a regression fixture and passes after the repair.