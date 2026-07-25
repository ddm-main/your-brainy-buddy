# Market Section Audit — Bugs & Gaps vs Live/Algo Trading Apps

Compared the current Market module (`src/routes/market/*`, `src/lib/market/*`, `src/components/market/*`, `supabase/functions/market-*`) against the flows expected in production trading apps (Zerodha Kite, Kotak Neo, Dhan, Groww, Upstox) and algo platforms (Streak, Tradetron, AlgoTest).

## 1. Order placement flow (Kite / Neo parity)

| # | Bug / gap | Where | Impact |
|---|---|---|---|
| 1 | **No bracket / cover order support** — real brokers expose BO/CO with attached SL + target legs. `market-order-place` only sends flat MARKET/LIMIT/SL/SL-M. | `supabase/functions/market-order-place/index.ts`, `OrderTicket.tsx` | Users can't place proper intraday risk-managed orders. |
| 2 | **No `disclosedQuantity` / `AMO` / iceberg fields in ticket** even though the edge function accepts them. | `OrderTicket.tsx` | Feature parity gap. |
| 3 | **`OrderTicket` allows submit while `place.isPending`** everywhere except footer; no Escape/enter shortcuts, no confirm on notional > ₹1 L. | `OrderTicket.tsx` | Fat-finger risk. |
| 4 | **Margin guardrail bypassable silently** — `skipMarginCheck` is not surfaced in UI but is accepted server-side; also LTP fallback only works if quotes edge is warm. | `market-order-place` L59-82 | Users hit broker rejects with cryptic errors. |
| 5 | **No price-band / circuit-limit check** before submission (Kite blocks orders outside 20% band). | ticket + edge | Broker rejects. |
| 6 | **Tick size not enforced** (₹0.05 for equity, ₹0.01 for select). Input uses `step=0.05` only. | `OrderTicket.tsx` L137 | LIMIT orders rejected. |
| 7 | **Lot size not enforced for F&O** — `product=NRML` allows any qty. | ticket | Rejects on F&O. |
| 8 | **Auto-fill limit price uses LTP not best bid/ask**; there's no depth (`market-depth` function exists but ticket doesn't consume it). | `OrderTicket.tsx` L42-44, `market-depth` | Poor fills. |
| 9 | **No post-only / bracket-modify flow** in `market-order-modify`. | edge fn | Modify UX is thin. |

## 2. Orders / trades book

| # | Bug | Where |
|---|---|---|
| 10 | Open-status set is hardcoded to a subset — misses `AFTER MARKET ORDER REQ RECEIVED`, `TRIGGER PENDING`, `AMO PENDING`, broker-specific strings. | `Orders.tsx` L11 |
| 11 | No **modify** action on pending orders — only cancel; `useMarketOrderMutations().modify` exists but is unused in UI. | `Orders.tsx` |
| 12 | Trades table has no P&L / average buy tie-up, no CSV export. | `Orders.tsx` L62 |
| 13 | Refetch interval is 10 s during market hours; broker WS updates aren't wired to invalidate order queries in real time. | `orderHooks.ts` L60 |
| 14 | `filled_qty` and `price` fields aren't validated for null before `.toFixed` — will crash if broker returns nulls. | `Orders.tsx` L125 |

## 3. Positions / Holdings / P&L

| # | Bug | Where |
|---|---|---|
| 15 | Positions page pulls DB rows but doesn't reconcile with live broker snapshot on refresh — MIS auto-square-off leaves stale "open" rows. | `Positions.tsx`, `market-sync-positions` |
| 16 | **Day P&L uses today's LTP − previous close** but for **intraday buys same-day** it should be LTP − avg buy price. `pnl.ts` was patched but Holdings still displays wrong Today P&L when a same-day buy exists. | `src/lib/market/pnl.ts`, `Holdings.tsx` |
| 17 | No **corporate-action adjustment** on holdings (splits/bonus/dividends applied via `market-corp-actions-apply` but there is no UI to trigger, no verification badge). | `Holdings.tsx` |
| 18 | Holdings has no **XIRR / CAGR / realized-vs-unrealized split** — table shows only current MTM. | `Holdings.tsx` |
| 19 | No **exposure / margin utilization** ring (funds card only shows a number). | `FundsCard.tsx` |

## 4. Watchlist & quotes

| # | Bug | Where |
|---|---|---|
| 20 | Watchlist has **no depth ladder** on hover / click, no quick-order buttons, no `Ctrl+B/S` shortcuts. | `WatchlistPanel.tsx` |
| 21 | Reordering is UI-only in some code paths; sort_order persistence for large sets not batched. | `WatchlistPanel.tsx` |
| 22 | Realtime tick subscription capped at 100 symbols but no warning when watchlist > 100. Silent tick loss. | `useRealtimeTicks.ts` L34 |
| 23 | If relay dies, chip stays "push · kotak" until next hello. There's no watchdog to flip back to "poll". | `useRealtimeTicks.ts` |
| 24 | No **circuit / halt / freeze** indicator on symbol. | quotes flow |

## 5. Charts / analysis

| # | Bug | Where |
|---|---|---|
| 25 | Only one chart type (candles). No line/area/heikin-ashi/renko toggle. | `CandleChart.tsx` |
| 26 | No **drawing tools** (trendline/fib/rectangle) — real trading apps require these. | `CandleChart.tsx` |
| 27 | Indicator settings modal saves per-user but doesn't sync across devices reliably (single-row upsert with no version). | `IndicatorSettingsModal.tsx` |
| 28 | Chart interval switch refetches full history each time; no incremental append using `market-candles`. | `Analysis.tsx` |
| 29 | Supertrend fixed earlier, but VWAP resets not aligned to IST session boundary; anchored-VWAP not available. | `chartIndicators.ts` |
| 30 | Volume histogram uses raw units; no lakh/cr formatting; no delivery% overlay. | `CandleChart.tsx` |

## 6. Screener

| # | Bug | Where |
|---|---|---|
| 31 | Screener runs client-side against `market_screener_rows` — for 2.7 k rows OK, but no pagination / virtualization; long lists lag. | `screenerRun.ts`, `Screener.tsx` |
| 32 | Sector / industry filter has no autocomplete; boolean columns can't be combined with numeric groups. | `screenerCatalog.ts` |
| 33 | Saved screener export/import missing. | Screener page |
| 34 | Results table doesn't offer "Add all to watchlist" / "AutoTrade rule from screener" — common in Tickertape/Streak. | Screener page |
| 35 | Filter counts (e.g., "24 stocks") not shown per filter (Tickertape shows facet counts). | Screener |

## 7. AutoTrade (algo layer)

| # | Bug | Where |
|---|---|---|
| 36 | **Backtest is separate from AutoTrade** — user can't backtest a rule before arming. No "backtest this rule" button on rule row. | `AutoTrade.tsx` |
| 37 | **No paper-trading mode** — only "dry-run once" or live. Streak/Tradetron ship paper-live as first-class. | `market-autotrade-eval` |
| 38 | Eval cadence and next-run time aren't shown; user can't tell when the rule will fire. | `AutoTrade.tsx` |
| 39 | Rule editor combines entry + exit into "one group" — no OR groups, no time-of-day filter, no cool-down between fires (mandatory to avoid re-entry loops). | rule editor |
| 40 | **Circuit-breaker resets are manual** — once `disabled_reason` set, only admin path clears it; no auto-reset next trading day. | `autotradeHooks.ts` |
| 41 | Open positions netted only by rule+symbol — if the same symbol is used by two rules, exits collide. | AutoTrade eval |
| 42 | No slippage / expected fill preview in dry-run output. | eval fn |
| 43 | Activity log truncated to 100 rows client-side; no filter by rule / level. | AutoTrade UI |

## 8. Realtime data / relay

| # | Bug | Where |
|---|---|---|
| 44 | Ticks come via a **user-run local relay** (`Apps/relay/kotak-ws-relay.mjs` was deleted in prior cleanup). If relay isn't running, "live" is REST-polled at 1–15 s — much slower than a real trading app. | `useRealtimeTicks.ts`, missing relay |
| 45 | No sequence-number / gap detection on tick stream; missed ticks silently. | tick store |
| 46 | Broadcast channel is `private: true` but no server-side auth on the relay's publish key. | relay design |

## 9. Backtesting

| # | Bug | Where |
|---|---|---|
| 47 | Only equity long-only bar-close backtests; no slippage/commission/impact model, no walk-forward, no multi-symbol portfolio backtest. | `market-backtest-run`, `Backtesting.tsx` |
| 48 | Results table has no equity curve chart, no drawdown, no Sharpe/Sortino. | `Backtesting.tsx` |

## 10. Alerts

| # | Bug | Where |
|---|---|---|
| 49 | Alert eval is polled server-side; no push to browser tab, only DB row + optional email. | `market-alerts-eval` |
| 50 | Alert can't fire an order (no "on trigger → place order" bridge that AutoTrade would give). | alerts UI |

## 11. Settings / config

| # | Bug | Where |
|---|---|---|
| 51 | Multi-broker support scaffolded (`market_provider` enum has zerodha/dhan) but only Kotak wired; UI still shows a picker that yields errors. | `Settings.tsx`, provider layer |
| 52 | TOTP secret storage: encryption relies on `STATEMENT_ENC_SECRET` (misnamed) — should be a dedicated `MARKET_TOTP_ENC_SECRET`. | edge secrets |
| 53 | Kotak reconnect modal doesn't debounce — repeated OTP starts possible. | `KotakReconnectModal.tsx` |

## 12. UX / navigation / cross-cutting

| # | Bug | Where |
|---|---|---|
| 54 | No global "Buy/Sell" hotkeys (B/S) or "/" to focus search — table stakes in Kite. | app-wide |
| 55 | No basket / multi-order flow (Kite Baskets, Neo Basket). | — |
| 56 | Symbol pages don't share breadcrumb / recent-symbols; Analysis loses selection on refresh if URL params change. | `Analysis.tsx` |
| 57 | `Analysis` chart doesn't render Kotak `market-depth` / open interest for F&O. | `Analysis.tsx` |
| 58 | Mobile: order ticket modal is fixed 460px; overflows on <400 px widths. | `OrderTicket.tsx` |
| 59 | Error boundary catches crashes but doesn't report to Sentry / an error sink; production diagnostics blind. | `Market.tsx` |

## 13. Data integrity / correctness

| # | Bug | Where |
|---|---|---|
| 60 | `market_fundamentals_global` sync is best-effort with mixed provenance; UI shows values without a "last updated / source" chip on every cell. | fundamentals UI |
| 61 | Index constituents from NSE cache only — no fallback; on NSE 429 the index detail page renders empty. | `market-index-constituents` |
| 62 | Rounding: some places `toFixed(2)` on `null`, others `?? '—'`. Inconsistent formatters. | many |
| 63 | Query limits: several DB reads hit the default 1000-row Postgres cap without pagination (`market_autotrade_log`, `market_ticker_trace`). | logs pages |

## Next step

Once you approve, I'll turn the highest-severity items (order safety: #1, #4, #5, #6, #7, #14; day-P&L: #16; watchlist tick cap: #22; AutoTrade paper mode + rule↔backtest: #37, #36; alerts → order bridge: #50) into a prioritized fix set and implement in a Phase 2 push. Let me know if you want to add/remove anything from that shortlist.
