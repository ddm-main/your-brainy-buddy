# Plan — Market sub-nav promoted to TopBar

## Goal
When the user is on `/market`, the global top navbar currently only shows `HUD | Market | Finance | Tasks | Projects` (the rest are hidden by section access). A second row below wastes vertical space showing `Overview | Screener | Portfolio | AutoTrade | Config`. Move those sub-sections into the top navbar itself when inside Market, so the bottom row disappears and the header carries the actual navigation the user needs.

## Scope (this task)
1. **TopBar.tsx** — when `loc.pathname` starts with `/market`, replace the top nav items with the Market groups (`Overview / Screener / Portfolio / AutoTrade / Config`), each filtered by `sections.has("market")`. Keep the JARVIS logo → clicking it (or any other section becoming visible) still routes home. If the user has access to other sections too, we still need a way to leave Market — solve this by keeping a small "sections" cluster on the left of the Market group tabs OR by turning the JARVIS logo area into a compact section switcher. **Recommendation: keep the standard top-level nav (HUD/Market/Finance/Tasks/Projects filtered by access) AND append the Market group tabs to its right with a subtle divider**, since users with only Market access will just see the Market groups (single "Market" chip disappears, replaced by its children).

   Concrete rule:
   - Base nav = accessible sections (`NAV.filter(...)`), but when on `/market` the `Market` entry is expanded inline into its GROUPS from `src/routes/Market.tsx` (Overview/Screener/Portfolio/AutoTrade/Config).
   - Divider (`|` styled with `var(--edge)`) between base sections and the expanded Market groups when both are shown.
   - Active-underline (`layoutId="nav-active"`) shared across all chips so the indicator glides.

2. **Market.tsx** — remove the top group tab row (lines 127–140). Keep the `SubTabStrip` for Screener/Portfolio (Stocks/Breakout, Overview/Holdings/Positions/Orders/GTT), which is a genuine second level and belongs in-page. Reclaims ~44px of vertical space.

3. **Source of truth** — export `GROUPS` from `src/routes/Market.tsx` (or a new `src/routes/market/nav.ts`) so TopBar imports the same array and future changes stay in one place.

4. **Responsive check** — at ≤1024px CSS width the combined bar may wrap; allow `flexWrap: "wrap"` on the nav container (already the case for Market groups) and verify no overflow.

## Deep-check — additional improvements observed
Listed for approval; none are executed unless you say so.

- **A. Sub-tab strip alignment**: `SubTabStrip` shows `Overview | Holdings | Positions | Orders | GTT` but the top group is called `Portfolio`. Once groups move up, this second-level strip stays and continues to work.
- **B. `/market/autotrade` and `/market/settings` have no sub-tabs** — after promotion these render as terminal top-level tabs, which is correct; nothing to add.
- **C. "Config" name collision** — the Market group is labelled `Config` (`/market/settings`) which is easy to confuse with the global Admin Panel (`/config`). Rename the Market entry to `Settings` for clarity. (Purely a label change.)
- **D. Access filtering** — `Market` groups should only appear when `sections.has("market")`; the current base-nav filter already covers this.
- **E. Keyboard nav** — SubTabStrip has ArrowLeft/Right/Home/End. The top nav doesn't. Add the same roving-tabindex pattern to the promoted Market group chips.
- **F. Active-match bug guard** — `NavLink` for `/market` needs `end` so it doesn't stay active on `/market/screener`, etc. (the current in-page code already handles it; the TopBar version must too).
- **G. Deep-link title** — `document.title = "Market · <label>"` (already in Market.tsx) stays correct after the move.
- **H. Nothing else changes**: routes, data hooks, `useMarketAutoSync`, `useRealtimeTicks`, `KotakReconnectModal` untouched.

## Technical details
- New export in `src/routes/market/nav.ts`:
  ```ts
  export type MarketGroup = { key: string; label: string; to: string; match: (p: string) => boolean };
  export const MARKET_GROUPS: MarketGroup[] = [ /* moved from Market.tsx */ ];
  ```
  `Market.tsx` and `TopBar.tsx` both import from here. `subs` stays inside `Market.tsx` since it's only rendered there.
- `TopBar.tsx` adds:
  ```ts
  const onMarket = loc.pathname.startsWith("/market");
  const marketVisible = sections.has("market");
  ```
  Render base NAV (skip `Market` when `onMarket` since it'd be redundant), then if `onMarket && marketVisible` render a `<span aria-hidden style={{ ... divider }} />` and the `MARKET_GROUPS` chips using the existing chip style.
- `Market.tsx`: delete the group-tab `<div role="tablist">…</div>` block; keep `SubTabStrip` for groups that have subs.
- No route changes, no data changes.

## Files touched
- `src/routes/market/nav.ts` (new, ~20 lines)
- `src/routes/Market.tsx` (delete group tab block, import GROUPS)
- `src/components/hud/TopBar.tsx` (inline expand Market when on `/market`, add divider, keyboard nav)

## Out of scope
Any change to Market data, hooks, edge functions, or the second-level SubTabStrip content. Global sidebar/other sections. Mobile bottom nav (there isn't one).
