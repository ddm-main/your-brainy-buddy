# Chart cleanup: fewer indicators, W/M intervals, no candle dropdown, resizable panes

## 1. Trim the indicator list (38 → 14)

Keep exactly the 12 favourites in your screenshot plus the two extra studies the breakout engine actually uses:

Keep: EMA, SMA, Bollinger Bands, VWAP, Supertrend, Volume, Volume Profile, RSI, MACD, ADX/DMI, Stochastic RSI, OBV, **ATR**, **MFI**.

ATR and MFI are added because `supabase/functions/_shared/market/scoring.ts` scores on ATR (stop/volatility band) and MFI alongside OBV/volume — you'd otherwise be unable to eyeball two inputs of your own breakout score.

Remove: WMA, HMA, DEMA, TEMA, VWMA, Envelopes, Keltner, Donchian, Parabolic SAR, Ichimoku, Stochastic, CCI, Williams %R, ROC, Momentum, Awesome Osc, TRIX, Ultimate Osc, CMF, Accum/Dist, Chaikin Osc, Aroon, Vortex, Std Deviation.

Implementation: `INDICATOR_DEFS` in `src/lib/market/indicatorRegistry.ts` is cut to the 14 defs; the maths for removed studies stays in `chartIndicators.ts` (harmless, used by tests) but is no longer selectable. `normalizeStudy` drops any saved study whose type no longer exists, so old layouts/localStorage load cleanly instead of crashing. Favourites in localStorage are filtered against the surviving types. With 14 entries the picker's All/Overlays/Oscillators/★ tabs stay but the counts shrink.

## 2. Week and Month intervals

Add `1W` and `1M` to `TIMEFRAMES` in `ChartToolbar.tsx` (non-intraday). The backend already serves them — `market-candles` has `1W`/`1M` mappings and resamples from the stored daily series — so this is a front-end wiring change only:
- Range menu bar-count maths (`rangeToBars`) gets per-timeframe divisors: ~52 bars/yr for 1W, ~12 for 1M (currently hardcoded 250/yr, which would show 3 pixels of a 5Y weekly chart).
- Keyboard TF shortcuts extended (6 = 1W, 7 = 1M).
- VWAP (intraday-only) stays hidden on W/M as it already is on 1D.

## 3. Remove the chart-type dropdown

Drop the `CHART_TYPES` menu from the toolbar; the chart renders candles permanently. `chartType` stays in the component API and is pinned to `"candles"` in `Analysis.tsx`, and persisted layouts that carry `heikin_ashi`/`line`/etc. are coerced back to candles on load, so no saved state breaks.

## 4. Pane resizing (the real bug)

`enableResize: true` is already set, so drag handles work — but the render effect ends with a block that recomputes and calls `panes[i].setHeight(per)` for every sub-pane. That effect re-runs on every data tick, timeframe change and study edit, so any height you drag is stomped back to the computed 90–180px within a second. That's why Volume can't be made taller.

Fix: apply the auto-sizing heights **only when the pane set changes** (a study added/removed/toggled, or first mount), never on data refresh. User-dragged heights are captured from lightweight-charts' pane-size change signal, stored per symbol+timeframe in localStorage alongside the other chart prefs, and reapplied after re-renders instead of the computed default. A "Reset pane sizes" item goes in the chart settings menu.

## Other issues found while checking, worth fixing in the same pass

1. **Live tick doesn't update oscillators.** Only price, volume and OBV have live-bar handling; RSI/MACD/ADX/MFI freeze at the last completed bar during the session. Fix by recomputing the tail of each oscillator on tick (cheap — last N bars only).
2. **Volume Profile doesn't recompute on data refresh.** The primitive is constructed with the candle array at attach time; after a poll brings new bars the profile keeps the stale set until a full re-render. Pass the refreshed series into the primitive on update.
3. **Range menu is hidden on intraday** but the loaded window for 1m/15m is fixed; a "1D / 5D / 1M of intraday" selector would remove the manual scrolling. (Optional — say if you want it.)
4. **Legend value for hidden studies** still reserves a row, leaving blank lines in the crosshair legend when a study is toggled off.
5. **`rangeToBars` ignores its `tf` argument entirely today** — dead parameter that silently makes 1h ranges wrong (250 bars ≈ 1.5 months of hourly, not 1 year). Fixed as part of item 2 above.

## Files touched

- `src/lib/market/indicatorRegistry.ts` — trimmed defs, tolerant `normalizeStudy`.
- `src/components/market/ChartToolbar.tsx` — W/M timeframes, range maths, chart-type menu removed, favourites filtered, reset-pane-sizes item.
- `src/components/market/CandleChart.tsx` — pane height persistence, live oscillator tail, volume-profile refresh, legend row fix.
- `src/routes/market/Analysis.tsx` — chartType pinned, TF shortcuts, pane-size prefs persistence.
- `tests/` — cover `normalizeStudy` dropping removed types and `rangeToBars` per timeframe.
