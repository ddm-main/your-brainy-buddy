# Add chart timezone bug to Market audit

Append one new issue to `.lovable/plan.md` under section "12. UX / navigation / cross-cutting" and add it to the Phase-2 shortlist.

## The bug

CandleChart renders bar times in **UTC**, not IST. Screenshot on `/market/analysis/KABRAEXTRU` (15M) shows the session starting at `03:45` — that is 09:15 IST (NSE open) displayed as UTC. NSE session (09:15–15:30 IST) therefore appears as 03:45–10:00 on every chart, and the daily separator lands at 05:30 IST midnight instead of the actual trading day boundary.

Root cause (confirmed by reads):
- `src/components/market/CandleChart.tsx` (line 207) calls `createChart` with no `localization.timeFormatter` / no `timeScale.tickMarkFormatter`. Lightweight-charts defaults to UTC for numeric `UTCTimestamp` values.
- `TradingViewChart.tsx` already passes `timezone: "Asia/Kolkata"` — only the native chart is wrong.
- Backend candle payloads (`market-candles`) return correct UTC epoch seconds; no server change needed.

## Fix

In `src/components/market/CandleChart.tsx`, in the `createChart(...)` options:

1. Add `localization.timeFormatter` that formats a `UTCTimestamp` as IST (`Asia/Kolkata`) using `Intl.DateTimeFormat` — 24-hour, `HH:mm` for intraday, `DD MMM 'YY` for daily+.
2. Add `timeScale.tickMarkFormatter` mirroring the same IST formatting so axis labels and the crosshair label agree.
3. Keep the underlying data in UTC epoch seconds — do NOT shift timestamps; only the display layer changes.

Verification:
- On a 15M chart, first visible tick of a trading day must read `09:15`, last `15:30`.
- Daily separator lines must land at IST midnight, not 05:30.
- Crosshair tooltip time must match the axis.

## Plan.md edits

1. Add row 64 in section 12:
   > 64 — CandleChart renders times in UTC; NSE session shows as 03:45–10:00 instead of 09:15–15:30 IST. Only `TradingViewChart.tsx` sets `timezone: "Asia/Kolkata"`; native `CandleChart.tsx` has no `localization.timeFormatter` / `tickMarkFormatter`. — `src/components/market/CandleChart.tsx`
2. Add `#64` to the "Next step" shortlist (chart correctness) alongside `#16` day-P&L.

No other files change in this pass — implementation of #64 will land in the Phase-2 push together with the rest of the shortlist.
