# Patterns: quieter chart, real evidence, no contradictions

Tested live (logged in, `/market/analysis/KCPSUGIND`, 5m and 1D, pattern studies on, detail = KEY). The tier system, the click-to-explain dialog and the A4 panel already exist and work. What's left is real: the chart is still noisy at KEY tier, structure labels collide and clip, candle explanations have empty/boilerplate fields, and two panels disagree with A4 about the same symbol.

## Confirmed issues

1. **Still noisy at KEY tier.** 1D/1Y draws ~60 markers; almost all are unlabelled dots. Too many keys are tiered `key` (piercing line, inverted hammer, harami-adjacent reads, gravestone doji), so "key" no longer means "matters".
2. **Structure labels collide and clip.** On the right edge: "Triple bottom" printed twice on the same column, "Rounded bottom · tri…" cut off by the price scale, "Bear flag · forming 70%" overlapping "Descending triangle · for…", and two bare "trigger" labels.
3. **Candle explanations are half-empty.** The dialog shows `Upper/Lower —`, `Level —`, `Touches: candle pattern` for candlesticks, and no "Measured evidence" block at all — candle marks carry no numeric evidence. Confirmation text is boilerplate ("Completed candle satisfies the geometry and context rule").
4. **Raw bar indices leak.** Window reads "bars 5955–5955 (1)" — an internal array index shown to the user.
5. **Panels contradict each other.** A4 lists 5 structures and the chart draws them, while A5 "Chart patterns" says *none detected* and A3's patterns bucket scores **0.0 / 11** with "no technical snapshot for this symbol". A4 reads live candles; A5/A3 read stored EOD `pattern_flags` that are empty for this symbol.
6. **A4 header timestamp** shows "1D · Aug 03, 12:00 AM" — midnight for a daily bar.
7. **Studies drop on timeframe change.** Switching timeframe resets the indicator set from 3 back to 1, silently turning the pattern studies off after "Show on chart".

## What gets built

### 1. Retier so KEY means KEY
Reduce `key` to genuine, standalone-tradeable reversals/continuations: engulfing (both), morning/evening star, three white soldiers / three black crows, three outside up/down, hammer, shooting star, hanging man, piercing line, dark cloud cover, abandoned baby. Everything else (harami, inverted hammer, doji family incl. gravestone/dragonfly, spinning top, marubozu, tweezers, inside/outside bar, NR4/NR7, plain gaps) drops to `context` or `noise`. Target: **≤ ~15 labelled marks per 250 visible bars**, and dots only from `+CTX` upward — at KEY tier nothing draws that has no label.

### 2. Label placement that never collides or clips
- Reserve the right margin: a chip whose text would cross the price scale is anchored left of its bar instead of clipped.
- One chip per bar column across *both* candle and structure marker sets (they currently thin independently, which is how "Triple bottom" doubled up).
- Dedupe structures by key + overlapping bar range, keeping the highest-confidence instance; cap labelled structures at 3 with the rest as bounds-only.
- Drop the bare "trigger" text markers — the trigger level already draws as a line and is stated in the dialog.

### 3. Candle evidence, measured not narrated
`pattern-series.ts` emits per-candle evidence for every candle mark: body/range ratio, upper- and lower-wick ratios, ATR at that bar, body vs prior body, gap size, close position within range, trend context (EMA slope / prior swing) and relative volume. The dialog then:
- renders the same "Measured evidence" table it already renders for structures;
- replaces boilerplate with the **actual rule and the actual numbers** ("upper wick 1.58 = 4.5× body 0.35, ≥ 50% of range 2.28 → shooting star");
- hides inapplicable fields (Upper/Lower, Level, Touches) instead of printing "—";
- states the concrete invalidation for candles: the price level that voids the read, with distance in ₹ and %.
- Detection thresholds are **unchanged**, so EOD breakout scores stay stable.

### 4. Window shown in human terms
"3 bars · Jul 28 → Jul 30, 2026 (1D)". Absolute array indices are removed from the UI (kept internally for focus/zoom).

### 5. Kill the contradictions
- A5's "Chart patterns" row and A4 read the **same live detection** when the chart's candles are available, falling back to stored EOD flags only when they are not — with the source labelled ("live 1D" vs "EOD Aug 03").
- A3's patterns bucket showing `0.0 / 11` alongside "no technical snapshot" is surfaced as **not scored (no snapshot)** rather than a scored zero, so a missing input can't read as a bearish verdict. Scoring math itself is untouched.
- A4 header shows the last bar's real timestamp for the timeframe (date only for 1D/1W/1M, date + time intraday).

### 6. Studies survive a timeframe switch
The pattern studies stay in the indicator set (and the "On chart ✓" state stays truthful) when the timeframe changes.

### 7. Verification
Re-run the logged-in pass on 5m / 1D / 1W: count labelled marks, confirm no clipped or overlapping labels, click a candle mark and a structure and confirm every field is either populated with numbers or absent, and confirm A4 / A5 / A3 tell the same story. Unit tests: retiered keys, cross-set label thinning, structure dedupe, candle evidence math, candle invalidation distance.

## Technical notes

- `src/lib/market/patternLabels.ts` — retier table; add per-key rule text used by the dialog.
- `supabase/functions/_shared/market/pattern-series.ts` — `evidence` + `confidence` + `invalidateLevel` on `CandleMark`; thresholds unchanged.
- `src/components/market/CandleChart.tsx` — shared label-slot allocator for candle + shape markers, right-margin guard, structure dedupe/cap, remove "trigger" text markers.
- `src/lib/market/indicatorRegistry.ts` — marker caps down; studies persist across timeframe change.
- `src/components/market/PatternDetailDialog.tsx` — evidence table for candles, numeric rule text, hide N/A fields, human window, invalidation distance.
- `src/components/market/PatternPanel.tsx` — header timestamp from last bar.
- `src/routes/market/Analysis.tsx` — A5 chart-patterns row sourced from live detection with source label; A3 bucket "not scored" state.
- `tests/patternTiers.test.ts`, `tests/patternSeries.test.ts` — extend. No migration, no edge-function redeploy.
