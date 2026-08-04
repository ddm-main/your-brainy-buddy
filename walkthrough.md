# JARVIS Market Portfolio Walkthrough

## Market data freshness repair

- The official NSE bhavcopy is now promoted into `market_daily_prices` before universe scoring, so the full settled market no longer depends on thousands of per-symbol provider calls.
- Daily orchestration now runs price promotion and batched rescoring before the detailed technical and aggregate passes.
- A run is healthy only when staging, daily-price, and score coverage reconcile for the same session; one intraday row can no longer mark a session complete.
- Analysis shows a compact pipeline-updating warning when the official close has landed but the selected symbol's technical score has not caught up.
- Settled-session detection uses the authoritative NSE bhavcopy with a full-market floor rather than ad-hoc daily rows.

## Portfolio audit changes

- Funds now uses a shared Kotak refresh path with cached fallback and retry cooldowns, so repeated Overview/Holdings/Positions refreshes do not hammer Kotak after 429/5xx responses.
- Funds displays a Kite-style breakdown: cash balance, margin from shares, used margin, available margin, and payin/options when present.
- Holdings and Positions sync buttons only appear when Kotak Neo is connected.
- Positions sync updates existing broker rows by symbol/exchange/side instead of deleting and reinserting every open position.
- Positions summary separates Today P&L, Today realized, and All-time realized.
- Manual close writes `exit_source: manual` for auditability.
- Holdings uses the shared holdings query hook and shows T1/pledged quantity details.
- Delete actions use HUD confirmation modals instead of browser `confirm()`.

## Funds failure behavior

When Kotak returns rate limits or upstream margin-service failures, the app shows the cached snapshot if one exists. If no snapshot exists yet, it shows a compact waiting state with the next retry timing instead of misleading empty fund tiles.