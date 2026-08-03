# Patterns you can trust, see, and click

Verified live (signed in as msdeepakdon@gmail.com, `/market/analysis/WENDT`): the Candles & Patterns panel (A4) lists 17 candlestick reads and 2 structures on the 5m chart, rows open the detail dialog, and the chart's indicator menu already contains "Candlestick Patterns" and "Chart Patterns" studies. What is missing is the link between the two, and the drawing quality of the structures.

## What is wrong today

1. **Nothing is drawn unless you hunt for it.** Pattern drawing only happens if you manually add the two pattern studies from the Indicators menu. The panel that found the patterns has no way to put them on the chart.
2. **Chart markers are unreadable.** Candlestick markers print short codes (`BE`, `H`, `MS`) with no hover text and no click target, so a marker cannot be traced back to its rule.
3. **Structures are drawn as a bare horizontal line.** The chart draws one flat level line from the pattern's start bar to its end bar, and **skips any shape whose level is null** — triangles, wedges, channels and flags that carry only upper/lower slopes render nothing at all, so a "2 structures" count can produce an empty chart.
4. **No forming/triggered legibility.** Dashed vs solid is the only cue; there is no trigger marker, no invalidation line, no confidence on the chart.
5. **Panel freshness label is wrong.** The A4 header shows an "EOD Jul 31" chip while the body is scanning live 5m bars.
6. **Patterns exist only on Analysis.** The IndexDetail chart page uses the same chart and has no pattern panel.

## What gets built

### 1. "Show on chart" button (the main ask)
A toggle in the Candles & Patterns panel header that adds/removes both pattern studies on the chart in one click, matching the panel's current tab, tone filters and bar window. Turning it off removes them. It persists with the other chart studies, so it behaves like any other indicator.

Per-row action too: clicking a row still opens the detail dialog; the dialog's Focus button additionally highlights that one pattern on the chart (its candles boxed, its levels drawn) instead of only scrolling to it.

### 2. Real pattern drawing, not codes
- Candlestick marks: marker text becomes the readable name (Shooting star, Bearish engulfing) with the short code as fallback when bars are tight, plus a tone-coloured arrow. Hover shows name + rule; clicking a marker opens the same detail dialog the panel row opens.
- Chart structures: draw the actual geometry —
  - triangles / wedges / channels: two sloped trendlines from the upper and lower bounds across the pattern window;
  - rectangles / double tops / bottoms / head-and-shoulders: boxed range plus the neckline level;
  - trigger arrow at the trigger bar when triggered, dashed invalidation line at the opposite bound;
  - label chip with name + status (forming / confirmed / triggered) + confidence.
- Shapes with a null level are no longer dropped; they draw from their bounds.

### 3. Explainability on every result
The detail dialog already shows formula, confirmation and invalidation text plus referenced candles. It gains:
- the exact bar range and timestamps of the detection window (for candle marks, the pattern's own bars rather than a fixed "last 12");
- the measured evidence behind the rule (body/range ratios, touch counts, tolerance, ATR used), not prose alone;
- distance-to-trigger and distance-to-invalidation in price and percent;
- a short "near miss" note when a related pattern was rejected on the same bar.

### 4. Correctness and trust pass
- Fix the A4 freshness chip so it reports the chart timeframe and last bar time, not the EOD snapshot date.
- Guarantee panel/chart parity: same detection call, same tone filters, same window, so "17" in the panel always equals 17 markers on the chart.
- Extend unit tests: geometry per structure family, null-level shapes, trigger/invalidation math, and marker/panel count parity.

### 5. Same panel on IndexDetail
Add the Candles & Patterns panel to the index chart page so behaviour is uniform across chart pages.

## Technical notes

- Files: `src/components/market/PatternPanel.tsx` (toggle + parity), `src/components/market/CandleChart.tsx` (marker labels, click routing, structure geometry, null-level handling, focus highlight), `src/components/market/PatternDetailDialog.tsx` (evidence, distances, exact window), `supabase/functions/_shared/market/pattern-series.ts` (expose per-detection evidence and near-miss reasons; detection rules unchanged), `src/lib/market/indicatorRegistry.ts` (label-style / show-forming params), `src/routes/market/Analysis.tsx` and `src/routes/market/IndexDetail.tsx` (wiring), `tests/patternSeries.test.ts`.
- No detection thresholds change unless a test proves a rule wrong — the EOD scorer reads the same engine, so breakout scores stay stable.
- No database migration or edge-function deploy required; the shared pattern module only gains optional fields.