# Breakout as its own Market section

Promote Breakout to a top-level Market group sitting between Screener and Portfolio, and move Calibration under it.

## Navigation

Top bar (on /market): Overview · Screener · **Breakout** · Portfolio · AutoTrade

Breakout sub-tabs: Breakout · Calibration
Screener sub-tabs: Stocks (Calibration removed; single tab strip hides itself)

## Routes

- `/market/breakout` becomes the canonical Breakout page (currently a redirect).
- `/market/screener/breakout` becomes a redirect to `/market/breakout` so old links keep working.
- `/market/calibration` stays as-is, now grouped under Breakout.

## Technical notes

- `src/routes/market/nav.ts`: add a `breakout` group (match `/market/(breakout|calibration)`) between `screener` and `portfolio`; narrow the screener match to `/market/(screener|score)`; move Calibration into a new `MARKET_SUBS.breakout` entry and drop it (and the breakout entry) from `screener`.
- `src/routes/Market.tsx`: swap the two breakout route lines so `breakout` renders `<Breakout />` and `screener/breakout` redirects.
- `src/components/config/providers/feedCatalog.ts`: point the Breakout `usedBy` link at `/market/breakout`.
- No backend or data changes.
