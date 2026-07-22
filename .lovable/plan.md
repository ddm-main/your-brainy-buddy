## Screener — Deep audit (2026-07-22) vs `.lovable/plan.md`

I re-audited the code against the existing plan. Many correctness items are already fixed; the remaining gaps cluster in perf, UX, new filters/universes, and AI features. Below is the current state and a recommended execution order.

### Already done (verified in code)
- **A1** DII/FII kept separate; `institutional_holding` = D+F sum.
- **A2** `instrument_type` preserved as NULL; scoped applicability handles unknown types safely.
- **A5** `latestTradeDateOf` now filters to `instrument_type === "EQ"`.
- **A7** `current_ratio`, `quick_ratio` catalogued; `sales`/`net_profit` still missing (see B7-part).
- **G41** partially — still 6× `try { localStorage } catch`.
- Live-overlay freshness gate (A3): overlaid rows now bump `trade_date` to `latestTradeDate` when a live quote is present. Effectively resolved.

### Still open — the real backlog

**A. Correctness**
1. **A4/E29** Universe fetch pages `market_screener_rows` twice (once for `is_nifty500` symbol set, once for rows). Merge to a single "all" fetch, filter client-side per universe.
2. **A6** `.select("*")` transfers unused columns (change_abs, previous_close, many raw fields). Trim to a `select` list of what the screener actually reads. ~30% payload reduction.

**B. Filter & coverage gaps**
3. Add filters: `sales` (Revenue Cr), `net_profit` (PAT Cr), absolute `high_52w`/`low_52w`.
4. Multi-timeframe returns: 5D, 21D (1M), YTD. Requires new columns in `market_screener_rows` view or computed from `market_daily_prices` — flag as data-dependent.
5. **B13** `sector_strength` shown as 0..1 — rescale to 0–100 label with percentile hint.
6. **B14** `bb_width`, `atr_pct` need inline unit hints (e.g. "% of price").
7. **B15** Enum filters (sector/industry) need search + "select all in group" (industries especially — 100+ options).

**C. Universes & saved screens**
8. Custom universes: "F&O only", "SME", "Nifty Midcap 150", "Nifty Smallcap 250", plus **watchlist-as-universe**.
9. **C17** Share links: bump `v: 3` → `v: 4`, drop unknown filter ids with a warn-toast on load.
10. **C18** Auto-load last saved: only when URL has no `?f=` **and** last-session `active.length > 0`. Add opt-out toggle.

**D. UI / UX**
11. Sort persistence (localStorage key `screener.sort.v1`).
12. Summary row above results: "N stocks · median PE · median ROE · median 1D".
13. Column widths persisted + resizable (DataTable enhancement).
14. **D22** `ScoreBadge` popover: click-to-pin on mobile.
15. Compare mode: checkbox column, floating "Compare N" bar → `/market/compare?symbols=…`.
16. **D26** `Applied` chips clickable → open that filter's editor in the rail; ✕ removes.
17. **D27** Empty-state CTA: name the most-restrictive active filter (`excludedByMissingData` per filter).
18. **D28** Preserve page within page when sort changes (only reset on filter/universe change).

**E. Performance**
19. **E30** `useScreenerSectors`/`useScreenerIndustries` → `useMemo` keyed on `rows` identity.
20. **E31** Throttle `liveQuoteByKey` rebuild to 250ms; keep push-tick store as ref, don't rebuild map per tick.
21. **E32** Debounce filter keystrokes 250ms before triggering the live-quote batch.
22. **E33** Memoise `filtered` — currently recomputes whenever `liveQuoteByKey` identity changes (every tick).

**F. AI / intelligence (net-new)**
23. Natural-language filter input → `lovable-ai` JSON-mode → `ActiveFilter[]`.
24. "Explain this row" side-drawer (fundamentals + technicals + latest news, 2-sentence summary).
25. Anomaly badges: server-side daily job, tag PE/RSI/RVol 2σ outliers vs sector.
26. Similar-stocks (top-5 cosine neighbours on numeric feature vector).
27. Backtest a screener against `market_daily_prices` (forward-return distribution over N months).

**G. Reliability**
28. **G40** Wrap `Screener` in an `ErrorBoundary` so a bad row doesn't white-screen the page.
29. **G41** Factor out a `safeStorage` helper; replace 6 inline try/catch blocks.
30. **G42** Wire an actual "Trigger sync" action into the `⋯` menu — the stale-data banner promises one that doesn't exist.

---

### Suggested execution order

**Pass 1 — Correctness & perf (low risk, high signal)**
- A4/E29 single fetch, A6 select trim
- E30–E33 memoisation & throttling
- G28 error boundary, G29 safeStorage, G30 sync action

**Pass 2 — Filter coverage & UX polish**
- B3 (sales/net_profit/52w abs) — data already in rows
- B5/B6 unit hints, B7 enum search
- D11 sort persist, D12 summary row, D16 clickable applied chips, D17 empty-state CTA, D18 page preservation

**Pass 3 — Universes & saved screens**
- C8 custom + watchlist universes
- C9 share-link versioning
- C10 auto-load rules

**Pass 4 — Advanced UX**
- D13 resizable/persisted columns
- D14 ScoreBadge pin
- D15 compare mode

**Pass 5 — AI (net-new)**
- F23 NL filter input → F24 explain-row → F27 backtest → F25 anomalies → F26 similar

**Pass 6 — Data-dependent**
- B4 multi-timeframe returns (needs view/pipeline change first)

---

### Notes for you

- I'm **not** proposing to touch business logic in `market-pipeline-eod` here — Pass 6 (B4) is the only item that needs a view/migration change and I'll flag it separately when we get there.
- Passes 1–2 are ~1 focused session. Pass 5 (AI) is where the real Tickertape-beating leverage is.

Tell me "go" for Pass 1, or name a subset — e.g. "Pass 1 + D16 + D17".
