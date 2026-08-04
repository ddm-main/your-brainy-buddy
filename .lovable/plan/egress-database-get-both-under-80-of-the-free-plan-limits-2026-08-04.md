# Egress + database: get both under 80% of the free-plan limits

## Verified state (read from the live DB and code just now)

- **Database: 357 MB** (~71% of 500 MB) — already under 80%. Largest tables:
  `market_daily_prices` 244 MB, `market_stock_scores` 26 MB, `market_score_history` 15 MB,
  `market_screener_snapshot` 13 MB. Retention config is in place (hot windows 300/150 days,
  intraday 7 d, indicators cache 1 d).
- **Egress: one dominant leak remains.** Today's measured rows
  (`system_egress_daily`, still flushing as of 09:46 UTC):

  | route | bytes today | requests |
  |---|---|---|
  | `srv:market_stocks` | **241.8 MB** | 2 603 |
  | `market_screener_rows (76c)` | 21.0 MB | 30 |
  | `srv:market_daily_prices` | 4.2 MB | 185 |
  | `srv:market_api_settings` | 3.9 MB | 1 026 |
  | `srv:market_intraday_prices` | 3.0 MB | 285 |
  | `srv:market_indicators_cache` | 2.8 MB | 101 |
  | `market-candles` | 2.8 MB | 175 |

  `srv:market_stocks` is 87% of today's egress — ~93 KB per request.

- **Root cause found.** The Kotak token map was already narrowed to per-symbol lookups
  with a 30-minute TTL (`provider.ts:340`), but the **Shoonya** token map was not:
  `getShoonyaTokenMap()` (`provider.ts:1312`) pages the *entire* symbol master
  (`market_stocks`, 1 000 rows per page, up to 40 000) behind a **60-second** TTL, and it is
  called on every `getQuotes`, `getOHLCV` and `getDepth`. That is exactly the
  ~93 KB × thousands-of-requests pattern in the table above.
- Secondary: the settings row is re-read with a 10-second TTL (1 026 reads ≈ 3.9 MB/day),
  and the screener view still ships a 76-column projection (~700 KB per fetch).

## The fix

### 1. Shoonya token map → per-symbol cache (the ~87% win)
Replace the whole-book pager with the same shape the Kotak map already uses:
- a `Map<key, {token, expiresAt}>` cache, 30-minute hit TTL / 5-minute miss TTL,
- `.in("symbol", chunk of 200)` reads for only the symbols requested,
- a failed read is never cached as a miss (so one blip can't pin symbols to Yahoo),
- `getQuotes`, `getOHLCV` and `getDepth` pass the symbols they need instead of asking for
  the whole book; `invalidateShoonyaTokenMap()` keeps working (clears the map).

Expected: 241 MB/day → well under 5 MB/day.

### 2. Settings-row read TTL
Raise `SETTINGS_TTL_MS` from 10 s to 60 s. Mutations already re-read through
`getFreshSettingsRow()`, so broker-reconnect correctness is unchanged.
Expected: 3.9 MB/day → ~0.7 MB/day.

### 3. Screener projection
Drop `score_components` and `data_provenance` from the screener column list and fetch
`score_components` lazily for the symbol whose score popover is open.
Expected: ~700 KB → ~450 KB per screener load.

### 4. Verify
After deploy, re-read `system_egress_daily` for the next day and confirm
`srv:market_stocks` collapses, then confirm the quota panel's cycle total is tracking under
4 GB (80% of 5 GB). No DB work is needed right now — 357 MB is already inside the target,
and existing retention jobs hold it there.

## Technical notes

Files: `supabase/functions/_shared/market/provider.ts` (token map + settings TTL),
`src/lib/market/screenerRun.ts` (projection). No schema migration, no behaviour change:
same tokens resolved, same quotes, same rows — just far fewer bytes.
