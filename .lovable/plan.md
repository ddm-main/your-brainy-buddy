# Fix Supertrend indicator rendering

## Problem

On the Analysis chart the Supertrend study draws long diagonal lines connecting historical up-trend segments to new up-trend segments (and same for down), instead of appearing as clean stair-stepped trailing stops. The screenshot for MAXIND shows red/green diagonals slashing across the chart.

## Root cause

The calculation in `src/lib/market/chartIndicators.ts::supertrend` is correct (standard Wilder ATR + basic/final band flip logic).

The bug is in the renderer in `src/components/market/CandleChart.tsx` (the `c.g === "supertrend"` branch, ~lines 306–329). On a trend flip it pushes a `null` gap on the *newly-inactive* side only. The newly-active side just appends its new value — which lightweight-charts then draws as a straight line from that side's *previous* segment's last point (potentially many bars ago) to the new point.

Sequence that breaks:
1. Downtrend → dnData ends at bar N.
2. Flip up at bar N+1 → dnData gets `null` (good), upData gets new value.
3. Flip back down → upData gets `null`; dnData appends new value, connecting straight back to bar N. (Bug.)

## Fix

In the Supertrend render branch, on every flip push a `null` whitespace point to **both** sides — the newly-inactive side (already done) and the newly-active side (missing) — before appending the current value on the active side. This breaks the polyline between non-adjacent same-trend segments so lightweight-charts renders each streak in isolation.

No changes to the indicator math, the flip-marker logic, or the calculation in `supabase/functions/_shared/market/indicators-advanced.ts` (server-side is unused for chart rendering).

## Files

- `src/components/market/CandleChart.tsx` — add the missing `null` gap on the newly-active side inside the `supertrend` render branch.

## Verification

- Reload `/market/analysis/MAXIND` with Supertrend enabled: green line only appears during up-trends, red only during down-trends, with clean gaps at flips — no diagonal cross-chart lines.
- Buy/Sell flip arrows continue to align at the same bars.
