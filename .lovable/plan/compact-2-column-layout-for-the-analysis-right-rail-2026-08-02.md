# Compact 2-column layout for the Analysis right rail

Apply the same two-column stat layout used by the Open / High / Low / Prev Close block to the panels below it, so the right rail reads denser and shorter.

## What changes

Panels in the right rail of the stock Analysis page:

- **Indicators (Daily)** — RSI, MACD, ADX, ATR %, BB Width, Rel Volume, Volume become a 2-column grid of compact stats. The two chip rows (Setups, Chart Patterns) stay full width, since chips wrap and need the room.
- **Range & Strength** — Resistance, Support, 52w High, 52w Low, From 52w High, RS vs NIFTY, Sector Rank, EMA 20/50/200 become a 2-column grid. Resistance/Support keep their small touch-count suffix; EMA keeps its slash triple.
- **Quote** block stays exactly as it is (it is already the reference layout).
- Breakout Intelligence and AI Verdict keep their current single-column rows — they are single headline values plus prose, not stat lists.

Values, labels, colour coding (green for near-52w-high, tone chips), live/EOD wording and click targets are unchanged — this is layout only.

```text
before                        after
Label ................ value  Label .... value   Label .... value
Label ................ value  Label .... value   Label .... value
```

## Technical notes

- Add a small `StatGrid` helper in `src/routes/market/Analysis.tsx`: a `display: grid` with `gridTemplateColumns: "1fr 1fr"`, `columnGap: 12`, matching the existing `dayBar` grid.
- Extend `CompactStat` to accept `children` (React nodes) in addition to a plain `value`, so rows with suffixes, coloured spans, or mixed content can reuse it, and give each cell a light `borderBottom: 1px solid var(--edge)` so rows stay visually separable at two per line.
- Convert the listed `Row` usages in panels A4 and A5 into `CompactStat` cells wrapped in `StatGrid`; leave `Row` in place for the chip rows and other panels.
- No data, query, or scoring logic touched.
