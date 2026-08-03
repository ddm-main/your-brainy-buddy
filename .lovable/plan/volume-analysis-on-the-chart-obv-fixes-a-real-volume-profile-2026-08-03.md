# Volume analysis on the chart: OBV fixes + a real Volume Profile

Goal: be able to read, on any chart, whether the volume is buying or selling — with a correct OBV and a new Volume Profile (VPVR) that splits each price row into up-volume vs down-volume, with POC and value area.

## What is there today (verified)

- `obv()` in `src/lib/market/chartIndicators.ts:399` is a plain cumulative OBV over `candles` — no MA/signal line, no session reset option.
- OBV renders as a single line in its own sub-pane (`CandleChart.tsx`, oscillator loop), legend value compacted (`COMPACT_TYPES`).
- There is no Volume Profile indicator anywhere — `INDICATOR_DEFS` in `src/lib/market/indicatorRegistry.ts` has 37 entries and none is a profile.

## Confirmed bugs to fix

1. **Indicator/bar index misalignment.** Studies are computed from the raw `candles` prop, but the chart plots them positionally against `data` — the sorted + de-duplicated copy built inside the render effect. Whenever the incoming series has a duplicate or out-of-order bar (the effect already logs when it drops some), every indicator, OBV included, is shifted by one or more bars against the candles. Same defect in the crosshair legend: `hoverIdx` is an index into `data`, but the value is read out of arrays computed over `candles`.
   Fix: compute studies from the same cleaned/sorted series the chart draws.

2. **OBV ignores the live bar.** The live-tick effect updates the price and volume series only, so during the session OBV freezes at the last completed bar while price and volume keep moving. Fix: extend the study input with the in-progress bar so OBV's last point tracks the session.

3. **OBV is unreadable as a signal on its own.** No smoothing line, so divergence/accumulation is eyeballed. Fix: add an optional OBV moving average (length param, second colour), the standard treatment.

## What gets added

**OBV upgrade** (`obv` def in the registry)
- Params: `maPeriod` (0 = off, default 20).
- Lines: `OBV` + `OBV MA`.
- Optional `resetDaily` flag for intraday timeframes so the cumulative line restarts each IST session instead of dragging in multi-day accumulation.

**Volume Profile (new indicator, `volumeProfile`)**
- Overlay on the price pane, drawn as horizontal histogram bars pinned to the right/left edge with configurable width, computed over the **visible** price range (VPVR) so it recomputes as you pan/zoom.
- Each price row splits volume into **buying (up) vs selling (down)** — a bar's volume is classified by close vs previous close, matching the volume-pane colouring already used — and renders as a two-tone stacked bar so the buy/sell balance at each price is visible at a glance.
- Overlays drawn: POC (point of control), VAH/VAL (value area, default 70%).
- Params: `rows` (default 24), `valueArea %` (default 70), `widthPct` of the pane (default 25), `side` (right/left).
- Legend row shows POC price and the visible-range buy/sell volume split as a percentage.

## Technical notes

- New pure helpers in `src/lib/market/chartIndicators.ts`: `obvWithMa()` (+ optional IST-session reset) and `volumeProfile(candles, {rows, valueAreaPct})` returning rows of `{priceLo, priceHi, upVol, downVol}` plus `poc`, `vah`, `val`.
- Volume Profile is drawn with a lightweight-charts v5 series primitive (`ISeriesPrimitive` attached to the price series) so it paints in the price pane's coordinate space and follows the price scale; it subscribes to visible-logical-range changes to recompute its bucket set.
- Registry: new `volumeProfile` def in the overlay group (so it appears in the Overlays list you have open) and updated `obv` def; `normalizeStudy` backfills params for saved layouts, so existing charts pick up the new OBV MA without breaking.
- Unit tests in `tests/marketIndicators.test.ts` for OBV (up/down/flat closes, MA, session reset) and for the profile (row bucketing, up/down split, POC and value-area boundaries).

## Files touched

- `src/lib/market/chartIndicators.ts` — OBV MA/reset, volume profile math.
- `src/lib/market/indicatorRegistry.ts` — updated OBV def, new Volume Profile def.
- `src/components/market/CandleChart.tsx` — compute studies from the cleaned series, live-bar-aware study input, OBV two-line pane, Volume Profile primitive + legend row.
- `src/components/market/volumeProfilePrimitive.ts` (new) — canvas renderer.
- `tests/marketIndicators.test.ts` — coverage.
