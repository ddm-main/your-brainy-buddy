## Fix stock name autocomplete

**Root cause (verified):** `src/components/market/SymbolSearchInput.tsx` queries `supabase.from("market_data")`, but that table does not exist in this project's schema. The tradable universe actually lives in `market_stocks` (2,703 active rows, confirmed via SQL). Every request 404s silently, so no suggestions ever appear as the user types.

This component is used everywhere symbol input matters: Watchlist, Planner, Positions, Holdings, OptionChain, Backtesting, AutoTrade, AI Engine.

**Change:** Point the autocomplete query at `market_stocks`.

- File: `src/components/market/SymbolSearchInput.tsx`
- Replace `.from("market_data")` with `.from("market_stocks")`
- Keep the same select columns (`symbol, exchange, company_name`), `is_active` filter, `.or(...)` prefix/contains match, exchange filter, and 8-row limit — all columns exist on `market_stocks`.
- No other files change. No schema, no edge functions, no UI/layout changes.

**Verification:** In build mode, load `/market/holdings` (or any page using the input), type a few letters (e.g. `REL`, `HDF`, `TATA`) and confirm the dropdown lists matching symbols with company names. Also confirm Enter with a highlighted suggestion selects it, and Enter on raw text still falls through to `onEnter`.