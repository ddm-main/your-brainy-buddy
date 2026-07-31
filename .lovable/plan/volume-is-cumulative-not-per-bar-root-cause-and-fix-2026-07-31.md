# Volume is cumulative, not per-bar — root cause and fix

## What the data actually shows (verified against the database)

TCS, 2026-07-31, `market_intraday_prices`:

- `kotak_quote` / `1m` — 334 rows, volume climbs monotonically 2,726 → 1,476,454 across the session.
- `yahoo_delayed` / `5m` — 67 rows, volume climbs 22,272 → 7,145,647.

Both series are **day-cumulative running totals stored as if they were per-bar
volumes**. That is exactly the staircase in the screenshot: every bar is taller
than the last because each one is "total traded so far today", not "traded in
this bar".

Two further defects fall out of the same data:

1. The Yahoo figure (7.14M) is ~5x the broker's own day total (1.47M), so the
   two stored series are not even on the same scale. Whichever one wins, the
   number under "Volume 1.45M" and the bars disagree.
2. `loadKotakTickBars` aggregates 1m rows into 5m buckets with
   `prev.volume += c.volume` — summing five *cumulative* values, inflating the
   bucket roughly fivefold on top of the original error.
3. The `kotak_quote` rows are quote snapshots with `open = high = low = close`,
   so intraday "candles" built from them have no real range either.

The client already carries a workaround for one bar only
(`CandleChart` deltas the forming bar), which is why just the newest bar looks
sane while the whole history behind it is wrong.

## The fix

**1. Store per-bar volume, never cumulative.**
When a bar is written from a quote snapshot (cumulative `day_volume`), persist
the *delta* against the previous stored bar of the same session instead of the
raw running total. Store the cumulative figure in its own column so the delta
can always be recomputed and never has to be guessed.

**2. Convert on read, so existing rows stop lying immediately.**
`market-candles` de-cumulates any series it reads that is monotonically
non-decreasing across a session (diff consecutive bars, floor at 0, reset at
each session start). This repairs today's and recent history without waiting
for new writes.

**3. Fix the bucket aggregation.**
Aggregate 1m → 5m/15m/etc *after* de-cumulating, so bucket volume is a sum of
true per-bar volumes.

**4. Stop mixing two incompatible volume scales.**
Pick one volume authority per session — the broker's, since the Quote panel and
the day total come from it — and scale/ignore the other rather than letting a
Yahoo row and a Kotak row for the same minute both contribute.

**5. Backfill the stored rows.**
One migration rewrites `market_intraday_prices.volume` for the affected recent
days from cumulative to per-bar, keeping the original value in the new
cumulative column. Only intraday rows are touched; daily/EOD tables are already
per-day and are left alone.

**6. Simplify the client.**
With the server returning honest per-bar volume, remove the forming-bar delta
hack in `CandleChart` and just render what arrives; the live bar's volume
becomes `day_volume - sum(printed bars)` in one place only.

## Validation

- Volume pane for TCS 5m shows a normal ragged profile (opening spike, midday
  lull), not a rising staircase.
- Sum of today's 5m volume bars equals the broker day volume shown in the
  legend (1.45M), within the forming bar.
- 1m, 5m, 15m and 1D each total to the same day figure.
- A second symbol (RELAXO) and an off-session load behave the same.

## Technical notes

- `supabase/functions/market-candles/index.ts` — de-cumulate on read, fix
  `loadKotakTickBars` bucketing, persist deltas plus a `cum_volume` column,
  single volume authority per session.
- `src/components/market/CandleChart.tsx` — drop the per-bar delta workaround.
- One migration: add `cum_volume`, backfill `volume` to per-bar for recent
  intraday rows.

No trading, order or credential paths are touched.
