
## Audit of the Analysis chart section

I traced the full chart stack: `Analysis.tsx` → `ChartToolbar.tsx` → `CandleChart.tsx` → `chartIndicators.ts` / `indicatorRegistry.ts`. Here's what I found, then what I'll change.

### Bugs & issues found

**Toolbar (`ChartToolbar.tsx`)**
1. **Duplicate duration controls.** Two menus both look like "durations": `Interval` (1D, 1W…) and `Range` (1 Day, 6 Months…). The `range` state is stored in localStorage and set on click, but `useCandles(sym, tf, exchange)` **never receives it** — Range is pure decoration. This is the "duplicate durations" the user is seeing.
2. **Two fullscreen buttons.** "More → Fullscreen · F" and a standalone maximize icon at the far right do the same thing.
3. **"Save current layout" is a no-op** — `handleSaveLayout` only toasts "Chart layout saved"; nothing is persisted beyond the studies/settings that autosave anyway.
4. **"Layout → 2 charts / 2×2 grid"** are permanently disabled ("soon") — clutter.
5. **"Open on tradingview.com"** hardcodes `NSE:` even when exchange is BSE.
6. **`Indicators` badge count** shows total studies including hidden ones — misleading when you toggle visibility off.
7. Menu is disabled in TV mode but there's no visual cue on the toolbar row explaining why several controls grey out at once.

**Indicator registry & math (`indicatorRegistry.ts`, `chartIndicators.ts`)**
8. **Supertrend already exists** but on the chart it renders as two thin lines (green up-segments, red down-segments) with no fill and no flip markers — doesn't look like industry standard. The `col[0]` color from the study settings is ignored (hardcoded UP/DOWN).
9. **Ichimoku cloud is missing the shaded cloud** — only the 4 lines are drawn, no Span A/B fill (the whole point of Ichimoku).
10. **VWAP** silently degrades to "typical price" on daily+ timeframes; we mark it dashed but never tell the user why in the legend.
11. **PSAR** draws as a connected `LineSeries` with `lineVisible: false` and `pointMarkersRadius: 1.6` — dots are barely visible and there's no color per trend flip.
12. **Volume study**: default color in registry is `BL` (blue), but on the chart bars are hardcoded green/red — the swatch in the picker lies.
13. **`aroon`** uses `period + 1` window (loops `j = i-period; j <= i`) instead of `period` — off-by-one vs. TradingView.
14. **`stoch` smoothing param** exists but `stochastic()` applies `smooth` to raw %K then `dPeriod` to that; TradingView convention is opposite (K = SMA of raw over `smooth`, then D = SMA(K, dPeriod)) — matches, but the label "Smooth" is under "%K" in UI and confusingly named. Cosmetic only.
15. **`sma` / `ema` (candle-based versions)** are hard-coded to `close` and ignore the `source` param — but the study registry advertises `hasSource: true` for MAs. `computeStudy` correctly routes MAs through `emaV(src(),…)` so this works, but the candle-based `sma()`/`ema()`/`wma()` exports are now dead code that will mislead anyone reading `chartIndicators.ts`.
16. **`macd` seed for signal EMA** requires `signalP` full non-null macd values before emitting — correct, but combined with the slow EMA warmup this delays first signal print by ~34 bars. Match TradingView by using EMA-seed = first value (not SMA of first N) so signal starts earlier. Minor.
17. **`stochRsi` `k` param** — registry `defaultParams` are `{ rsiPeriod: 14, stochPeriod: 14, k: 3, d: 3 }`, but the function positional args are `(candles, rsiPeriod, stochPeriod, kPeriod, dPeriod)` — call site passes `p.k`/`p.d`, correct. OK.
18. **`chartType` change** rebuilds the entire chart (candles→line), which is fine, but the `computed` memo also rebuilds every render because `studies` array identity changes even when studies didn't. Wrap toggle/remove/update in stable identity or memoize `computed` on serialized studies. Perf, not correctness.
19. **Live tick**: `livePrice` updates the last bar's high/low/close but **does not extend a new bar** across a session boundary. On intraday timeframes after the current-bar's window closes, ticks still glue to the old bar until the next fetch. Low-priority.

**Indicator settings modal**
20. Params use free numeric input with `min/max/step` from `ParamMeta`, but there's no client-side clamping, so entering `-5` for period silently produces NaN cascades. `atr(candles, -5)` returns all-null and the study renders blank with no error.

**Legend / crosshair**
21. Legend value formatting uses `.toFixed(2)` for every study — Aroon (0–100), OBV (raw shares), MFI (0–100) all get 2 decimals whether meaningful or not. OBV in particular should be compact-formatted (K/M/B) like the OHLCV header does.

### What I'll change

Scope is chart-section-only (toolbar + registry + CandleChart + settings modal). No API/DB work.

**1. De-duplicate durations & clean the toolbar** (`ChartToolbar.tsx`, `Analysis.tsx`)
- Remove the entire **Range** menu. Delete the `range`/`onRange` props, drop it from `Persisted`. Interval (`tf`) becomes the single source of truth.
- Remove the standalone right-side fullscreen icon (keep the one in More).
- Delete the disabled "2 charts / 2×2 grid" items; either keep "Save layout" wired to a real persistence slot (a named preset in localStorage) or remove it. I'll wire it to save the current `{studies, settings, chartType, tf}` under `jarvis.analysis.layout.<name>` with a "Load layout" submenu, so it stops being a lie.
- Fix TradingView external link to use `${exchange}:${symbol}`.
- `Indicators` badge counts only `visible` studies.
- Add a small tooltip on the "TV" segment explaining why chart-type/indicators grey out.

**2. Fix indicator rendering** (`CandleChart.tsx`)
- **Supertrend**: render as a stepped line with a translucent fill to price (green fill below price when `dir=1`, red fill above when `dir=-1`), plus small triangle markers at flips (TradingView-style). Honor `study.colors[0/1]` for up/down.
- **Ichimoku cloud**: add two BaselineSeries (or two LineSeries + area fill approximation) between Span A and Span B, green when A>B, red when B>A.
- **PSAR**: switch to a dot-only rendering using `LineSeries` with `lineVisible:false` + `pointMarkersRadius: 3` and color-swap per direction (compare dot vs. close).
- **Volume**: sync the registry swatch (`defaultColor`) with the actual green/red bars — set swatch to the up color and note "bar color reflects candle direction" in the picker.
- **VWAP**: append a `(session-anchored — daily TF ignored)` note in the legend row when non-intraday.
- **Legend formatting**: introduce a per-def `format` helper — `compact` for OBV/AD/Volume, `.toFixed(2)` for prices, `.toFixed(1)` for oscillators bounded 0–100 (RSI, StochRSI, MFI, Aroon, %K/%D, %R).

**3. Fix indicator math bugs** (`chartIndicators.ts`)
- **Aroon**: change loop to `j = i - period + 1; j <= i` so window is exactly `period` bars.
- Delete dead candle-based `sma()`, `ema()`, `wma()`, `bollinger()` exports (superseded by `smaV`/`emaV`/`wmaV`/`bollingerV`).
- MACD signal: keep current SMA-seed but emit the seeded value one bar earlier (currently we skip the seed bar). Small alignment fix.
- Add param clamping in `computeStudy`: coerce `period`/`fast`/`slow`/`signal`/`atrPeriod` etc. to `Math.max(1, Math.floor(n))` before running math, so bad user input can't produce all-null output.

**4. Supertrend (already exists — polish + surface it)**
- The user asked to "add Supertrend" — it's registered but visually mediocre. After the render polish in (2), promote it into `DEFAULT_STUDIES` alongside EMA 20/50/Volume, so a new user sees it immediately.
- Registry: add a second color slot for the down-trend segment so users can theme both.

**5. Indicator settings modal**
- Clamp inputs to `[min, max]` on blur and round to `step`. Show inline validation when out of range.

**6. Persistence bump**
- Bump `STATE_STORE` to `v5` because the `Persisted` shape loses `range`; the loader already falls back to `defaultState` on parse errors, so old v4 blobs will just reset cleanly.

### Files to touch

```text
src/components/market/ChartToolbar.tsx     — remove Range, dedupe fullscreen, layout save/load, tv link fix, indicator count
src/routes/market/Analysis.tsx             — drop range state, bump store to v5, DEFAULT_STUDIES incl. Supertrend
src/components/market/CandleChart.tsx      — Supertrend fill+markers, Ichimoku cloud, PSAR dots, per-study legend formatter, VWAP note
src/lib/market/chartIndicators.ts          — aroon window fix, drop dead exports, param clamping helper
src/lib/market/indicatorRegistry.ts        — Supertrend second color, Volume swatch fix, DEFAULT_STUDIES
src/components/market/IndicatorSettingsModal.tsx — clamp/round on blur
```

### Explicitly out of scope

- Multi-chart layouts (2×2 grid) — real work, separate feature.
- Server-driven historical range beyond `tf` — needs `useCandles`/edge-function changes.
- Drawing tools (trendlines, Fib) — separate feature.
- TradingView-mode parity (its UI owns its own indicators/settings).
