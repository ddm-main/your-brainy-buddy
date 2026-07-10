
# Hardening — remaining work

Audit of what's actually in the repo right now, then a focused fix list. Password auth stays as-is per your instruction.

## ✅ Already done (verified in code)

- `verify_jwt = true` on all 5 edge functions; `getClaims()` guard in `_shared/auth.ts`.
- CORS allowlist with `.lovable.app` / `.lovableproject.com` suffix match — stale preview id already gone.
- All 30 tables: `user_id NOT NULL DEFAULT auth.uid()` + owner-only RLS; `anon` has no grants.
- Signups blocked at DB (`block_new_signups` trigger on `auth.users`).
- Weekly `pg_cron` job for `purge_old_jarvis_interactions()`.
- `jarvis-vision` bucket: per-user folder policies.
- `jarvis-vision-upload`: MIME allowlist + 8 MB cap.
- `jarvis-chat`: per-user 20 req/min sliding-window rate limit; `escapePgrst` on all `.or()` calls (notes/decisions lines 543/547 confirmed); `open_url` removed; `summarize_file` locked to project storage host with 15s timeout + 8 MB cap; `stepCountIs(10)`.
- `types.ts` is fresh (includes `user_id` on every table).
- `/reset-password` route + sign-out in `TopBar` present.
- `supabase_realtime` publication empty.
- CSP + `Referrer-Policy` + `Permissions-Policy` in `index.html`.

## 🔧 Remaining — what this plan fixes

### 1. SSRF hardening on outbound fetch (`jarvis-chat`)
`ddgSearch` (line 43) and `summarize_file` fetch already have timeouts, but no private-IP block or response-size cap on `ddgSearch`. Add a shared `safeFetch(url, {timeoutMs, maxBytes})` helper in `_shared/http.ts` that:
- Rejects non-`https:` (except the DDG host), `file://`, `localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7` by resolving host string.
- Enforces `AbortSignal.timeout(timeoutMs)` (default 8s).
- Streams response and aborts past `maxBytes` (default 2 MB for search, 8 MB for files).
- Route `ddgSearch` and `summarize_file` through it.

### 2. `X-Lovable-AIG-Run-ID` propagation (`jarvis-chat`)
Rewrite `_shared/ai-gateway.ts` using the knowledge-file pattern:
- `createLovableAiGatewayRunIdFetch` closure that captures/resends the run id.
- `getLovableAiGatewayRunId(req)` to read the incoming header.
- `withLovableAiGatewayRunIdHeader` wrapper around the streaming response.
Wire the provider factory in `jarvis-chat` per-request and forward the header on the response.

### 3. Per-user daily token/request cap (`jarvis-chat`)
Add a `jarvis_usage_daily` table (`user_id`, `day date`, `requests int`, `tokens int`, PK `(user_id, day)`) with RLS. Before hitting the gateway, upsert-increment `requests`; after the stream finishes, add `usage.totalTokens`. Return `429 quota_exhausted` above configurable caps (default 500 req/day, 500 000 tokens/day). Uses a security-definer RPC to keep the counter atomic.

### 4. Kill `const supabase: any = _supabase as any`
Delete the cast in `src/lib/db.ts`, `jarvisChat.ts`, `jarvisTools.ts`, `reminders.ts`, `screenShare.ts`, `vision.ts`. Replace `AnyRow` aliases with real generated types (`Database['public']['Tables']['tasks']['Row']` etc.). Fix any resulting compile errors by narrowing selects / typing insert payloads properly.

### 5. Money as integer paise
Migration converts `numeric` money columns to `bigint` paise on: `financial_accounts.balance_paise`, `credit_cards.limit_paise` + `outstanding_paise`, `loans.principal_paise/emi_paise/outstanding_paise`, `financial_goals.target_paise/current_paise`, `subscriptions.amount_paise`, `transactions.amount_paise`. Data migrated with `(amount * 100)::bigint`. Add tiny `inrFromPaise` / `paiseFromInput` helpers in `src/lib/money.ts`; update `db.ts` wrappers and every form (Finance route) to convert at the boundary. `inr()` in `db.ts` becomes `inrFromPaise`.

### 6. Lint / format / typecheck / test / CI
- Add `eslint.config.js` (typescript-eslint + react-hooks + react-refresh), `.prettierrc`, `.prettierignore`.
- `package.json` scripts: `lint`, `format`, `typecheck`, `test`.
- Vitest config + first three tests: `escapePgrst`, `safeFetch` private-IP block, `paiseFromInput` rounding.
- `.github/workflows/ci.yml`: on push/PR run `bun install && bun run typecheck && bun run lint && bun run test`.

### 7. Supabase Auth dashboard toggles (you)
I can't flip these — after this ships, in the Auth settings:
- Enable **Confirm email**.
- Enable **Leaked password protection**.
- Set **Minimum password length ≥ 12**.

## Execution order (single build session)

1. Migration: `jarvis_usage_daily` + money columns + RPC (`increment_usage`). *One migration, shown for approval before running.*
2. Edge: new `_shared/http.ts` (safeFetch) + rewritten `_shared/ai-gateway.ts` + `jarvis-chat` wiring (SSRF, run-id, quota).
3. Client: purge `as any`, add `money.ts`, update Finance forms.
4. Tooling: ESLint / Prettier / Vitest / CI workflow + three seed tests.
5. Redeploy the 5 edge functions and hand back the Auth dashboard checklist.

## Technical notes

- No changes to auth method (password stays).
- Rate-limit map stays in-memory (per-isolate); quota table is the durable per-day cap.
- No table renames — money columns are added as `*_paise` alongside old columns, backfilled, old columns dropped in same migration.
- Streaming preserved: `withLovableAiGatewayRunIdHeader` waits only for upstream headers, not tokens.

Approve and I'll start with the migration diff.
