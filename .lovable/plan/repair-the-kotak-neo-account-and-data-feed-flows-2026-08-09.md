# Repair the Kotak Neo account and data-feed flows

## Confirmed issues

- The account and system data-feed rows are correctly separated in the main provider resolver, but two supporting paths still cross that boundary:
  - `market-test-connection` can test the other purpose’s Kotak row when the requested row is missing.
  - user-triggered `market-kotak-refresh` refreshes every Kotak row owned by that user because it does not filter by `purpose`.
- This explains why an action from the user broker screen can surface the admin data-feed row’s decryption failure.
- The database currently has a Kotak `purpose='data'` row with unreadable encrypted credentials, while no usable `purpose='account'` Kotak row is available for the personal trading flow.
- Ciphertext written with an older `STATEMENT_ENC_SECRET` cannot be recovered in code. That row must either use the original secret or have its mobile number, MPIN, and TOTP secret entered again.
- Kotak Neo does not currently expose historical candles to this integration. Historical bars must remain Yahoo/NSE-backed; only the forming live bar can be synchronized to Kotak’s live quote.

## Changes

1. **Enforce the purpose boundary everywhere**
   - Make connection tests query only the requested `account` or `data` row, with no fallback to the other plane.
   - Pass the requested purpose into surface-level health tests and apply the same strict filter for Kotak and Shoonya.
   - Make manual session refresh target only the current screen’s purpose; retain cron refresh for all configured rows.
   - Require admin authorization before manually refreshing a data-feed row.

2. **Make provider eligibility honest**
   - Treat Kotak as usable only when it has either a complete active session or the full credential set needed for auto-login—not merely a TOTP blob.
   - Keep account operations on the user’s `purpose='account'` row and market-data operations on the designated `purpose='data'` system row.
   - Keep Yahoo/NSE fallback out of account-bound holdings, positions, funds, orders, and trades.

3. **Improve recovery behavior in the broker UI**
   - Send `purpose` when refreshing a session and match the returned result to the exact settings row.
   - When credentials are unreadable, show the re-entry form only after the user chooses Edit, hide misleading Re-login, and require mobile, MPIN, and TOTP together.
   - Disable refresh when no readable TOTP secret exists.
   - Label account and data-feed capabilities separately so personal account actions do not imply they power shared market data.

4. **Remove stale credential loops**
   - Centralize unreadable-Kotak cleanup so login, refresh, quotes, and account reads clear only the affected row’s stale encrypted values and session metadata.
   - Preserve consumer key and UCC so recovery requires entering only the secret fields that cannot be decrypted.
   - Return a stable recovery error that points to the correct screen: user broker config for `account`, admin provider config for `data`.

## Verification

- Add focused tests proving account test/refresh never reads or modifies a data-feed row, and data-feed test/refresh never selects an account row.
- Run the Kotak provider, login, session, and account-flow tests.
- Deploy the affected edge functions and inspect their logs.
- With authentication available, verify both screens independently:
  - Personal broker connection creates/uses only `purpose='account'` and account endpoints no longer report the data-feed decryption error.
  - Admin data-feed connection creates/uses only `purpose='data'`; after credentials are re-entered, quotes/depth use Kotak while historical candles remain explicitly Yahoo/NSE-backed.