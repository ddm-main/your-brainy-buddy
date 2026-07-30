## What's actually wrong (verified against the live system)

I probed the database, provider-health rows and edge logs for NILKAMAL during today's open session. Three independent faults, one shared root: two Kotak REST routes are answering wrong, and the code correctly falls back to honest-but-degraded states.

**1. Charts are delayed, not broken.** The chart renders — it renders *Yahoo* bars. Edge log, 04:45 today:
`[kotak] kotak:charts/v2/history circuit open for 3600s after 1 failure(s): Kotak API 404: 404 page not found`
Kotak's `POST {base_url}/charts/v2/history` returns a bare 404 on this gateway, the circuit breaker opens for an hour, and every intraday request for every symbol serves 15-minute-delayed Yahoo bars. Meanwhile `getQuotes` against the *same* session is succeeding (146–176 ms, `ok:true`) — so the session and token are fine; the chart URL is wrong for this account's data centre (`E41`, `server4`). Note `market_intraday_prices` is fresh (last row 04:49 today, 1,102 rows) — we have live 1-minute data locally that the chart currently ignores.

**2. Market depth is empty because the payload is empty.** Every poll logs:
`getDepth empty book for NSE:NILKAMAL (market open) keys=0`
`keys=0` means Kotak returned a data node with *zero* fields — not a shape we failed to parse. NILKAMAL has a valid token (`2421`, `nse_cm`), and quotes on the identical `script-details/1.0/quotes/neosymbol/...` path work. So the two `quote_type` variants we try (`all`, `depth`) are not the ones this gateway serves a book on. The panel then shows "Broker feed hiccup — retrying", which is honest but useless.

**3. Breakout Intelligence is thin for this symbol, not broken.** v4 scores now exist (2,133 of 2,910 rows). But `market_score_history` holds 2,230 rows across a partial universe, **all** `context_neutral = true`, and NILKAMAL has no rows at all — hence "No snapshots yet" and "not fitted yet". The backfill drain is running but the current symbol isn't prioritised, and calibration deliberately excludes neutral rows so it can never fit from backfill alone.

## Plan

### Phase 1 — Probe the two broken Kotak routes (must run first)
Write a one-off diagnostic edge function that, using the live system session:
- Tries the charts request against the alternatives — DC base vs. the `gw-napi` gateway host, `/charts/v2/history` vs. the interval/segment variants — and reports which returns candles.
- Enumerates every `quote_type` on `quotes/neosymbol/nse_cm|2421/<type>` (`all`, `depth`, `ltp`, `ohlc`, `market_depth`, `quote`, `full`, `52w`) and dumps the top-level keys of each response.

The exact fixes below depend on what this returns; if no chart route works on this gateway, Phase 2 uses the local-data path instead and I'll say so plainly rather than pretending Kotak can serve it.

### Phase 2 — Live, accurate charts
- Point `kotakCandles` at whichever host/path the probe proves, and reset the tripped breaker.
- Add `market_intraday_prices` as the **live** intraday source ahead of Yahoo: when Kotak charts fail during the session, build 1m/5m/15m bars from our own stored ticks (which are current to the minute) instead of serving delayed Yahoo. Yahoo stays the last resort and stays labelled `DELAYED`.
- Stitch the forming candle from the live tick so the last bar tracks the LTP.
- Keep the provenance chip truthful: `live · kotak`, `live · local`, or `delayed · yahoo`.

### Phase 3 — Market depth
- Use the working `quote_type` from the probe; keep the multi-variant walk as a fallback and cache the winner per isolate.
- Widen the parser to the shape the probe reveals (nested `buy`/`sell`, flat `bp/bq/bno`, or whatever Kotak actually returns) and add a unit test with the captured payload so it can't silently regress.
- Prefer the WS relay's pushed book when the relay is alive; only poll REST otherwise (already wired, currently unused because nothing is pushing).
- Replace "Broker feed hiccup" with a specific reason when the ladder genuinely isn't available.

### Phase 4 — Breakout Intelligence
- Prioritise the symbol on screen: when a user opens Analysis for a symbol with no history, queue it at the front of the backfill drain so its sparkline fills within a cycle instead of waiting for the alphabetical drain.
- Raise the drain batch size and widen the cron window so the universe finishes in days, not weeks.
- Make the nightly aggregates pass write **full-context** (`context_neutral = false`) rows so `fit_score_calibration` has fittable input; surface "0 full-context sessions so far" in the panel instead of a bare "not fitted yet".
- Show per-bucket attribution from the stored `buckets` jsonb once the fit has rows, and keep the neutral-row caveat visible.

### Phase 5 — Verify
Re-poll depth and candles for NILKAMAL against the live session, confirm `getDepth ok:true` and `history_source: kotak_neo` in provider health, and screenshot the Analysis page.

## Technical notes
- Files: `_shared/market/kotakClient.ts` (chart URL, depth variants/parser), `_shared/market/provider.ts` (fallback ordering), `market-candles/index.ts` (local intraday source), `MarketDepthLadder.tsx`, `ScoreHistoryPanel.tsx`, `market-score-backfill`.
- No schema changes needed for Phases 1–3; Phase 4 is cron/params plus panel copy.
- The circuit breaker stays — it's what stopped 9,658 duplicate health rows/day — but it needs a manual reset after the URL fix.
