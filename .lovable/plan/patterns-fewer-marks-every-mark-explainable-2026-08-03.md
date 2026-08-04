# Patterns: fewer marks, every mark explainable

Confirmed in the code that draws your screenshot:

- `candlePatterns` study keeps **every** detection with a matching tone and caps at `maxMarks` (default 250, yours is set to 400) — `src/lib/market/chartIndicators.ts:150`. There is no notion of "important". Inside bars, NR7, spinning tops, gaps, tweezers all print with equal weight.
- Every marker gets a **text label** (`m.label`, short code only when >45 markers) — `CandleChart.tsx:789`. On a 1D chart with 250+ marks this is the wall of overlapping text in your screenshot.
- `chartPatterns` draws up to 12 structures, each with upper/lower/level/invalidation lines **plus a label chip** ("Rounded top · forming 70%"), and overlapping structures repeat nearly identical text on the same bars — the smear on the right half of the chart.
- The A4 panel lists 26 candlestick reads inside a 20-bar window because it applies no significance filter either (`PatternPanel.tsx`).

## What gets built

### 1. Significance tiers (the core fix)
Each pattern key gets a tier in the shared registry: **key** (major reversal/continuation with a real edge), **context** (structure/volatility reads worth a glance), **noise** (inside bar, NR4/NR7, spinning top, plain doji, ordinary gap up/down, tweezers, marubozu, harami).

Tier is derived once and reused by chart and panel so they never disagree.

### 2. Chart drawing becomes quiet
- Default: only **key**-tier candlestick patterns draw a labelled arrow. Context tier draws a small unlabelled dot (still clickable, still opens the dialog). Noise tier is not drawn at all.
- New study param **Detail: key / key+context / all** replaces the blunt `maxMarks` behaviour; `maxMarks` default drops to 60.
- Collision guard: at most one labelled marker per N bars of horizontal space (computed from visible bar spacing) — extra marks on the same cluster keep the dot, drop the text, and the label goes to the strongest mark (highest confidence, then key tier).
- Structures: label chip only on the **most significant non-overlapping** shapes (default 4), placed at the shape's right edge, one chip per bar column; overlapping duplicates of the same key collapse to the best-scoring instance. Bounds lines stay but drop to lower opacity when the shape is only "forming".

### 3. Panel matches, with a visible filter
- A4 gains a small **KEY / +CONTEXT / ALL** toggle (default KEY), so "Candlesticks (26)" becomes a handful of reads that matter, with the count reflecting the active tier.
- Rows show tier and confidence; the bias chip counts only the displayed tier.
- Panel count and chart marker count are guaranteed equal for the same tier setting.

### 4. Explainability on click (the "trustworthy" half)
The detail dialog gains, for both candles and structures:
- exact bar range + timestamps of the detection window, and the OHLC of the referenced candles;
- the measured evidence, not prose: body/range ratio, shadow ratios, gap size, ATR used, touch count and tolerance for structures;
- confirmation state (forming / confirmed / triggered), trigger level and invalidation level, each with distance in price and %;
- why it is tiered the way it is, in one line.

### 5. Bugs fixed along the way
- Chart markers currently ignore the panel's window and tier — parity fixed.
- Shapes whose `level` is null still label/behave correctly; duplicate near-identical shapes deduped.
- A4 header chip shows "EOD Aug 03" while the body scans live 1D bars — it will report the chart timeframe and last bar time.
- Neutral candlestick marks are off by default in the study but the panel counts them — unified.

### 6. Verification
- Log in as the provided account, open `/market/analysis/KCPSUGIND`, and confirm on 5m / 1D that markers are legible, labels do not overlap, clicking any marker or dot opens its explanation, and panel count equals chart marker count.
- Unit tests: tier assignment per key, label-collision thinning, shape dedupe/overlap collapse, trigger/invalidation distance math, panel↔chart parity.

## Technical notes

- `src/lib/market/patternLabels.ts` — add `tier` to the registry plus `tierOf(key)`.
- `src/lib/market/chartIndicators.ts` — tier filter + `detail` param for `candlePatterns`/`chartPatterns`; lower default caps.
- `src/components/market/CandleChart.tsx` — labelled-vs-dot markers, collision thinning by bar spacing, structure chip selection/dedupe, keep click routing.
- `src/lib/market/indicatorRegistry.ts` — new `detail` param, new defaults (existing saved layouts migrate to `key+context`).
- `src/components/market/PatternPanel.tsx` — tier toggle, tier-aware counts/bias, parity with chart.
- `src/components/market/PatternDetailDialog.tsx` — evidence, window, distances, tier reason.
- `supabase/functions/_shared/market/pattern-series.ts` — expose per-detection evidence fields (ratios, touches, tolerance, ATR) and a confidence for candle marks; **detection thresholds unchanged** so EOD breakout scores stay stable.
- `tests/patternSeries.test.ts` — extend.
- No migration, no edge-function redeploy.
