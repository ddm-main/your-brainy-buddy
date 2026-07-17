## Root cause of the 502

The current client hits deprecated v1 endpoints on `gw-napi.kotaksecurities.com`. The Kotak Neo API v2 docs confirm the real endpoints and hosts have all changed:

| Call | Current (broken) | Correct v2 |
|---|---|---|
| Login (TOTP) | `gw-napi.../login/1.0/login/v6/totp/login` | `mis.kotaksecurities.com/login/1.0/tradeApiLogin` |
| Validate MPIN | `gw-napi.../login/1.0/login/v6/totp/validate` | `mis.kotaksecurities.com/login/1.0/tradeApiValidate` |
| Holdings | `gw-napi.../Portfolio/1.0/portfolio/v1/holdings?sId=` | `<baseUrl>/portfolio/v1/holdings` (GET) |
| Positions | `gw-napi.../Orders/2.0/quick/user/positions?sId=` | `<baseUrl>/quick/user/positions` (GET) |
| Limits | `gw-napi.../Orders/2.0/quick/user/limits` (GET) | `<baseUrl>/quick/user/limits` (POST) |
| Quotes | `gw-napi.../apim/quotes/1.0/quotes/neosymbol/…` | `<baseUrl>/script-details/1.0/quotes/neosymbol/<query>[/<filter>]` (GET) |
| Scrip files | `gw-napi.../Files/1.0/masterscrip/v2/file-paths` | `<baseUrl>/script-details/1.0/masterscrip/file-paths` (GET) |

Critical detail we're missing: **the `baseUrl` for all post-login calls is returned by `tradeApiValidate`** (e.g. `https://cis.kotaksecurities.com` or `https://neo-gw.kotaksecurities.com/xyz`). Today we hardcode `gw-napi` for everything, so once the login is fixed the follow-up calls would still 404.

That's why every login attempt returns 502 and no amount of retrying, timing, or TOTP re-registration fixes it.

## Fix

### 1. `supabase/functions/_shared/market/kotakClient.ts`
- Constants:
  - `LOGIN_HOST = "https://mis.kotaksecurities.com"` (fixed, used only for login + validate).
  - Drop `DEFAULT_BASE` for post-login calls; use a per-session `apiBase` returned by validate.
- `kotakLogin`:
  - `POST ${LOGIN_HOST}/login/1.0/tradeApiLogin` with the existing headers/body.
  - `POST ${LOGIN_HOST}/login/1.0/tradeApiValidate` with the same headers plus `sid`/`Auth` from step 1.
  - Extract `baseUrl` from the validate response and return it as `apiBase` on `KotakSession`.
- `KotakSession` gains `apiBase: string`.
- `persistSession`:
  - Write `apiBase` into `market_api_settings.base_url` (repurpose that column — it already exists) so subsequent invocations pick it up.
- `sessionHeaders`: unchanged, but callers now build URLs from `s.base_url` (the validated `apiBase`, not `gw-napi`).
- Update callers to the new paths:
  - `kotakHoldings` → `GET ${base}/portfolio/v1/holdings` (no `sId` query).
  - `kotakPositions` → `GET ${base}/quick/user/positions`.
  - `kotakLimits` → `POST ${base}/quick/user/limits` with `{ seg: "ALL", exch: "ALL", prod: "ALL" }`.
  - `kotakQuotes` → `GET ${base}/script-details/1.0/quotes/neosymbol/<query>/<filter>` (filter defaults to `ohlc`/`ltp`/all as today).
  - `kotakScripFilePaths` → `GET ${base}/script-details/1.0/masterscrip/file-paths`.
- `KotakError` message: already surfaces raw body; keep as-is.
- Keep `withKotakSession` auto re-login on 401/403.

### 2. `supabase/functions/market-kotak-login-start/index.ts` & `market-kotak-login-otp/index.ts`
- No structural change; they already return `KotakError.message` verbatim. Confirm the message now includes real Kotak text (e.g. "Invalid credentials or TOTP.") rather than "Kotak API 502".
- Once the request goes to `mis.kotaksecurities.com`, the transient `gw-napi` 502s disappear.

### 3. Base-URL migration
- The `base_url` column on `market_api_settings` currently stores the user-entered `gw-napi.kotaksecurities.com`. After the fix it stores the `apiBase` from validate. On first successful login the column is overwritten automatically. The Settings UI "Base URL" input becomes a stale display value:
  - Hide the "Base URL" and "WebSocket URL" inputs from `src/routes/market/Settings.tsx` (they were user-editable overrides for the v1 API and are no longer relevant — apiBase is discovered per session).
  - Backend still accepts a user-provided `base_url` on save (harmless; overwritten by validate).

### 4. Frontend resilience (Settings + TOTP panel)
- `src/routes/market/Settings.tsx`:
  - TOTP submit: auto-retry once on 502 with a 1.5 s delay before surfacing the error (Kotak APIM occasionally hiccups).
  - Show the raw error inline below the TOTP input (persistent) in addition to the toast, so users can screenshot/copy it.
  - Reset the inline error on the next submit.

### 5. Deploy + verify
- Deploy `market-kotak-login-start`, `market-kotak-login-otp`, `market-sync-holdings`, `market-sync-positions`, `market-quotes`, `market-scrips-sync`, `market-test-connection`, `market-kotak-refresh` (any function that transitively imports `kotakClient.ts`).
- Verification:
  - Save credentials → Login to Kotak → enter TOTP → expect `connected` status and populated `hs_server_id`/`base_url`.
  - Test Connection → expect ok.
  - Sync Holdings → expect rows.

## Files touched
- `supabase/functions/_shared/market/kotakClient.ts` (rewrite endpoints + session shape)
- `src/routes/market/Settings.tsx` (hide legacy URL inputs, TOTP retry + inline error)
- No DB migration needed; `base_url` column reused.

## Out of scope
- WebSocket URL discovery (docs still list the WSS host as static; no user-visible feature depends on it today).
- Order-placement endpoints (not used by the app).
