# Chart time axis: why "30 Jul" appears twice, and the rest of the bugs

## Confirmed root cause of the duplicated date label

`src/components/market/CandleChart.tsx` builds axis labels with a *stateful* formatter:

- `fmtAxis` (lines 329-355) keeps mutable closure variables `_lastDayKey` / `_lastMonthKey` and prints a date only when the current tick's IST day differs from the previously formatted tick.
- lightweight-charts v5 does not guarantee that `tickMarkFormatter` is called once per tick, in left-to-right order, or only for visible ticks. It re-formats ticks on every zoom/pan pass and for candidate marks it later discards.
- Result: the "first tick of a new day" test fires more than once for the same session (two `30 Jul` labels), and a genuine session start can print `09:15`/`11:2x` instead of its date — exactly the pattern in the screenshot.

The library already tells us what kind of label a tick wants via the second argument (`tickMarkType`: Year / Month / DayOfMonth / Time / TimeWithSeconds). TradingView-style axes are built statelessly from that value.

## Other bugs found in the same area

1. **Phantom `02 Aug` bar on a non-trading day.** The live-tick effect (lines ~779-810) rolls a brand new bar whenever wall-clock time has advanced one `gap` past the last bar, with no check that the market is open or that the incoming quote is fresh. With the delayed Yahoo/stale-Kotak quote arriving on Sunday 02 Aug, it invents bars stamped "today", producing the trailing `02 Aug` axis label and the flat `O=H=L=C=864.40`, `Volume 0` header.
2. **Session-break setting does nothing.** `sSessionBreaks` only tweaks `rightOffset` (line 393); the comment admits it. Overnight gaps are still drawn as if continuous, which is a second reason the intraday axis looks wrong versus TradingView.
3. **Intraday detection is fragile.** `_medianGap` is computed from the first 8 bars only (line 306); with an overnight gap inside that window the median can exceed a day and mis-flag an intraday chart as daily/monthly, changing all label formats.
4. **`isMonthly` derived from the same 8-bar median** (line 314) misclassifies weekly/monthly views after a data refresh race.
5. **Live volume delta scan is O(candles) per tick** (lines ~812-830), re-scanning the full candle array on every quote; with 5m/5d plus fast ticks this is avoidable work on the render path.
6. **Legend/header shows the invented live bar** (lines ~865-880) instead of the last real session close when the market is closed, so the OHLC strip reads a fabricated bar.

## Fix plan

1. **Make the axis formatter stateless.**
   - Use the `tickMarkType` argument: `Time`/`TimeWithSeconds` → `HH:mm` IST, `DayOfMonth` → `DD Mon`, `Month` → `Mon 'YY`, `Year` → `YYYY`, all rendered through the existing `Asia/Kolkata` formatters.
   - Delete `_lastDayKey` / `_lastMonthKey` and the day-boundary heuristic. This alone removes the duplicated `30 Jul` and restores dates on true session starts.
2. **Stop inventing bars when the session is closed / quote is stale.**
   - Gate the bar-roll and bar-extend paths on market-open state (reuse `useMarketOpen`) and on the quote's `as_of` matching the latest trading date.
   - When closed or stale, leave the last real candle untouched so the axis ends at 31 Jul and the header shows the real close and volume.
3. **Harden timeframe classification.**
   - Compute the bar interval from the `timeframe` prop the caller already knows, using the median gap only as a fallback, and take the median over a much larger sample of intra-session gaps (ignore gaps larger than a day).
4. **Honour the session-breaks toggle** by feeding the chart only session bars and relying on lightweight-charts' index-based spacing (no artificial time whitespace), so overnight gaps collapse like TradingView instead of being faked with `rightOffset`.
5. **Trim the live-volume work** by keeping a per-day printed-volume total in a ref, recomputed on candle refetch rather than per tick.

## Validation

- Open GMMPFAUDLR 5m: axis shows one label per session start (`29 Jul`, `30 Jul`, `31 Jul`) with `HH:mm` in between, no repeats, no `02 Aug`.
- Zoom and pan repeatedly: labels stay stable (a stateless formatter cannot drift).
- With the market closed: last bar equals the 31 Jul close, header volume is the real printed volume, no flat zero-volume candle.
- Switch 1M / 5M / 15M / 1H / 1D: label style matches the timeframe on the first render, without depending on the first 8 bars.

## Technical files

- `src/components/market/CandleChart.tsx` — stateless `tickMarkFormatter`, market-open/staleness gating of the live-bar effect, interval classification from props, session-break handling, live-volume ref.
- `src/lib/market/useMarketOpen.ts` — reused for the open/closed gate (no change expected).
- `src/routes/market/Analysis.tsx` — pass the active timeframe/interval down if not already available to the chart.
