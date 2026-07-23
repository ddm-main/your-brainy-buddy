# Market Overview — cleanup plan

Scope: `/market` Dashboard. Remove duplicate/unwanted panels, keep the current three-column Row 2 (Top Breakouts · Watchlist · Portfolio).

## Removals

- **Breadth panel** (`BreadthPanel`) — removed from the overview. Data was duplicated by `MarketStrip` (A/D, VIX) and by the strip's regime cues.
- **Top Movers panel** (`TopMoversPanel`) — removed from the overview. Screener-driven Top Breakouts already covers "what to look at today"; a separate movers list was redundant.
- Both component files are kept in the repo (unused on this route) so we can re-introduce them elsewhere without a re-write.

## Bugs & polish being fixed in the same pass

1. **Duplicate index tiles** — `Market Summary` panel repeats NIFTY / SENSEX / BANKNIFTY that `MarketStrip` already shows. Removed. `Global Market` panel is removed too (empty for most users, and its indices can live in the strip via an IN/GLOBAL toggle).
2. **MarketStrip** becomes the single header row:
   - Fixed-width numeric slots (tabular-nums + `ch` min-widths) to stop jitter on tick.
   - `⋯` menu on the right: **Manage indices · Prime data · Refresh**, plus an **IN / GLOBAL** toggle for which indices the strip renders.
   - Render `—` for exact-zero change instead of "▲ +0.00%".
   - Show the "MKT OPENS IN …" countdown only when the market is closed; drop it during session (the green dot + clock is enough).
   - Inline error state if `useIndices` fails ("indices unavailable — retry").
3. **Top Breakouts header** — drop the chip that echoes the `<select>` value. Keep: screener select, match-count chip, live/closed/stale chip.
4. **Portfolio (right column, unchanged position)** — display fixes only:
   - "Today" tile shows day P&L + `dayPct` when known; explicit `—` when partial.
   - Zero-value tiles keep neutral tone (no red on `0`).
5. **Watchlist** — legacy-seeded empty lists ("Watchlist 2/3/4") are collapsed on first mount to a single "Default" when they're empty and were created together. Replace `window.prompt/confirm/alert` for rename/delete/new with the app's HUD modal + toast. Staleness shown as a coloured dot instead of the word "stale".
6. **Reliability** — swap all raw `localStorage` / `sessionStorage` reads in `Dashboard.tsx` for `safeStorage` (already exists in `src/lib/safeStorage.ts`).
7. **Manage Indices modal** — port to `HudModal` for keyboard/focus parity; validate Yahoo symbol inline instead of `window.alert`.

## Final layout

```text
┌───────────────────────────────────────────────────────────────┐
│ MarketStrip · indices · A/D · FII/DII · IST · ⋯               │
├───────────────────────────┬──────────────────┬────────────────┤
│ Top Breakouts             │ Watchlist        │ Portfolio      │
│ (screener-driven, wider)  │                  │ Holdings       │
│                           │                  │ Positions      │
│                           │                  │ Orders         │
└───────────────────────────┴──────────────────┴────────────────┘
```

Row 2 grid stays 3-column, tightened to `minmax(0, 2.4fr) minmax(0, 1.6fr) minmax(0, 1.1fr)` so Watchlist isn't starved on 1280–1440.

## Files touched

- `src/routes/market/Dashboard.tsx` — remove Market Summary, Global Market, Breadth, and Top Movers rows; keep the existing Row 2 (Top Breakouts · Watchlist · Portfolio) as the main content; move Manage/Prime/Refresh into MarketStrip's `⋯`; use `safeStorage`.
- `src/components/market/MarketStrip.tsx` — fixed-width numeric slots, `⋯` menu, IN/GLOBAL toggle, null-safe rendering, error state.
- `src/components/market/WatchlistPanel.tsx` — legacy-list cleanup, HudModal-based rename/delete/new, staleness dot.
- `src/components/market/BreadthPanel.tsx` — untouched, no longer imported by Dashboard.
- `src/components/market/TopMoversPanel.tsx` — untouched, no longer imported by Dashboard.
- No DB, edge-function, or hook changes.

## Verification

- No NIFTY/SENSEX/BANKNIFTY duplication anywhere on `/market`.
- Breadth and Top Movers panels are gone.
- Row 2 still has three columns; Portfolio remains on the right.
- Top Breakouts header shows one chip only.
- MarketStrip `⋯` opens Manage Indices, triggers Prime, and refreshes.
- Watchlist shows a single "Default" after cleanup; rename/delete via HUD modal.
- Screenshots at 1280 and 1440 to confirm layout.
