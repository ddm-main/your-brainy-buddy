# JARVIS Market Portfolio Walkthrough

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