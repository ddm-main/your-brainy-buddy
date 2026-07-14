# Finance — Security Checklist (2026-07-12)

## RLS matrix
All finance tables scoped to `auth.uid() = user_id`. No `anon` grants.
New in this pass: `category_rules`, `merchant_aliases`, `budgets`,
`finance_suggestions`, `finance_reports`.

## Encrypted fields
- Statement passwords: AES-256-GCM via `STATEMENT_ENC_SECRET` (`_shared/crypto.ts`).

## Storage
- Private bucket `statement-pdfs`; reads go through `finance-statement-pdf-url` (short-TTL signed URL after RLS check).

## Edge-fn JWT
- `verify_jwt = true` on all `finance-*` except `finance-detect` /
  `finance-monthly-report` which additionally accept a cron path
  guarded by `x-cron-secret` = `SYNC_HOOK_SECRET`.

## Prompt-injection wrap
Every AI-fed user/parsed-statement string is wrapped in
`<untrusted_data>…</untrusted_data>` with explicit "ignore instructions".

## Follow-ups
- Rate limiter on `finance-chat` and `finance-monthly-report`.
- Zod coverage sweep on remaining fns.
- Unit tests for `financeMetrics`, `reconciliation`, `recurringDetector`,
  `loanCalc`, `categorize`, `budget`, `detectors`.