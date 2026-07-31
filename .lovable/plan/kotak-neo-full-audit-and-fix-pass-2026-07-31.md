# Kotak Neo — full audit and fix pass

Deep audit of the Kotak Neo integration (client, edge functions, hooks, UI). Everything below was verified against the code and live database, not inferred.

## What is actually broken

### 1. Funds/margin never persists (your "funds is down")
The hourly self-test calls the broker's limits endpoint directly and only writes a pass/fail probe row. It never writes the result into `market_funds`. Confirmed: the funds probe ran today at 12:24 IST, but the `market_funds` row is still from 2026-07-30 05:42. So the card shows day-old zeros while the probe flickers between ok and degraded.

Also confirmed: no scheduled job exists for funds, holdings, or positions. The cron list has 39 jobs; `market-sync-holdings`, `market-sync-positions`, and `market-funds` are not among them. Account data only ever updates when you press a button.

The probe's own message today ("available margin not reported") comes from the old parser, which the local code already fixes — the deployed function predates the fix. Needs a redeploy and a re-probe to confirm.

### 2. Ask-side depth quantities are wrong (data corruption, silent)
In the flat-payload branch of the depth parser, the sell side is parsed with the buy-size field name instead of the sell-quantity field. Every ask row's quantity on that payload shape is either zero or a wrong number, with no error raised. This feeds the depth ladder and order ticket.

### 3. A dead session can keep reporting "connected"
- After an auto re-login, the retried broker call is not wrapped in error handling, so a session that keeps failing after re-login is never marked expired — the UI keeps showing "connected" while every call fails.
- "Test Connection" persists an error status for Shoonya only. A failed Kotak test leaves the stored status untouched, so the config page can keep claiming "connected" right after a test that just failed.
- The connect panel prints "valid until <date>" straight from the stored expiry without comparing it to the current time, so it can show a past date next to a green chip.

### 4. Orders and trades stop refreshing
The order book and trade book freeze their poll interval at mount. Open the page before 09:15 and it never auto-refreshes for the rest of the day; open it during the session and it keeps polling all night. The codebase already has the fix helper (`liveInterval`) used everywhere else — these two hooks were missed.

### 5. The app now has two brokers but the status layer only knows one
Funds, holdings, positions, and both order feeds are declared as Kotak-only chains, and the price chip hardcodes the label "kotak". A Shoonya user sees their broker's outages blamed on Kotak and every live price labelled Kotak.

### 6. TOTP retry can trip a broker-side lockout
Auto-login retries three different codes back-to-back with no delay, even when the broker explicitly answered "invalid OTP" — where an adjacent time window cannot help. Brokers commonly lock the account after repeated bad OTPs.

### 7. Smaller correctness/UX defects
- Reconnect popup always starts on "Reconnect now" even when the session is already awaiting an OTP, discarding the outstanding challenge. The settings panel already handles this correctly.
- Failed order responses are re-labelled as "HTTP 409" client-side; that status was never returned. Misleads anyone diagnosing an order failure.
- The connect panel says credentials are "never sent back to the browser" while decrypting and displaying the saved mobile number on load.
- Funds cooldown timer keeps ticking (and re-rendering) after the cooldown expires.
- Modify-order sends an extra undocumented order-id field; Kotak 400s on unexpected fields elsewhere.
- Mobile normalisation double-prefixes a number already stored as `91XXXXXXXXXX`.
- 429 backoff is linear ~400/800ms with only two retries — too weak for the burst rate-limiting this gateway does.

## Fix order

**Wave 1 — wrong data and stale data**
1. Fix the ask-side depth field.
2. Make the funds self-test go through the snapshot path so a successful probe writes `market_funds`; redeploy and re-probe to clear the stale "degraded".
3. Add scheduled syncs for funds, holdings, and positions (post-open, midday, post-close on weekdays) so account data is never a day old.

**Wave 2 — honest session status**
4. Wrap the post-relogin retry and mark the session expired when it still fails.
5. Persist an error status on a failed Kotak test-connection, matching Shoonya.
6. Treat a past `token_expires_at` as expired in the connect panel.
7. Stop TOTP retries on an explicit invalid-OTP answer; add jitter between the remaining attempts.

**Wave 3 — live UI**
8. Switch orders/trades to the function-form poll interval.
9. Make account feed chains and the price chip provider-aware (Kotak or Shoonya) instead of hardcoded.
10. Open the reconnect modal directly on OTP entry when the session is already pending OTP.

**Wave 4 — polish**
11. Drop the fabricated 409; carry the real status.
12. Mask the mobile number or correct the security copy (I will mask it, matching MPIN/TOTP).
13. Clear the funds cooldown interval at zero.
14. Drop the speculative modify-order field; fix `+91` double-prefix; widen 429 backoff with jitter.

## Technical notes
- Files touched: `supabase/functions/_shared/market/kotakClient.ts`, `selftest.ts`, `funds.ts`, `market-test-connection/index.ts`, one new migration for the three cron jobs, `src/lib/market/orderHooks.ts`, `src/components/config/providers/feedCatalog.ts`, `src/components/market/{PriceSourceChip,KotakReconnectModal,BrokerConnectPanel,FundsCard}.tsx`.
- Edge functions redeployed: `market-selftest`, `market-funds`, `market-sync-holdings`, `market-sync-positions`, `market-test-connection`, `market-depth`, `market-order-*`.
- Regression tests added for the depth ask-side parse, the invalid-OTP no-retry rule, and the funds snapshot write.
- No schema changes beyond the cron schedule migration.
