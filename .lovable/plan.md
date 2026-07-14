
# Statements pipeline — root-cause fix + real parsers

## What I checked against the live DB (not the earlier plan)

- `email_accounts` for 07statement@gmail.com is already correct: `finance_only=true, treat_all_as_finance=true, sync_frequency=daily, sync_period_days=365, sync_status=ok`.
- Two `pg_cron` jobs already schedule `gmail-sync-due` every 15 min (`gmail-sync-due-15m` and `gmail-sync-due-every-15m`) — one is a duplicate.
- `statements.parse_reason` / `parser_confidence` columns exist. `credit_cards` is fully populated (6 rows, last-4 = 2605/6003/6560/6662/4814/0337). No SBI duplicates in `banks` currently.
- 48 emails synced from that mailbox, all `provider='gmail'`. 21 SBI statement rows are linked (bank + card_id both set) yet stuck at `parse_status='pending'` with **`parse_error IS NULL`**. That is the smoking gun: `ingestStatementAttachment` is being skipped or is early-returning silently — it never wrote *any* reason.

So the real remaining work is **not** schema/cron/config — it's fixing the silent drops in the ingest path, wiring specific error reasons, and turning the parser skeletons into real bodies. The "purge + re-ingest on retry" idea is the cleaner approach and is the one adopted below.

## Why the "purge on retry" approach wins

Two candidates:

1. Keep current row, patch fields in place on retry.
2. On retry, purge derived data (`transactions where source_statement_id=…`, `file_path`, parsed fields, `email_attachments.storage_path`), re-download, re-parse, re-link, then re-insert. Row identity preserved.

(2) wins because: no half-written rows on password change, no orphan transactions when a wrong card was linked first, deterministic idempotency (retry == first run), and the UI can trust `parse_status` at a glance. Cost is one extra DELETE per retry, which is negligible.

## Fixes

### Wave 1 — kill the silent drops (root cause of the current 21 stuck rows)

In `supabase/functions/_shared/finance-extract-core.ts`:

- `ingestStatementAttachment`
  - Line 261 `if (!payload) return;` → write `parse_status='failed', parse_error='gmail_payload_empty', parse_reason='fetchMessagePayload returned null'` before returning. Same treatment on `!attRow` (line 326), `upErr` (line 298–301), and the `console.warn` branches. Every early-return persists a specific reason.
  - Wrap the whole body in a top-level try/catch that writes `parse_error='ingest_crashed', parse_reason=<message>` — never leave a row silent.
- `applyParsedStatementResult`
  - On `!result.ok` branch: also set `parse_reason` from a small map — `password_required → 'password_missing'`, `wrong_password / wrong_or_missing_password → 'password_failed'`, `file_too_large → 'pdf_too_large'`, `too_many_pages → 'pdf_too_many_pages'`, otherwise `<verbatim error>`.
  - On success: also set `parse_reason` to `'parsed_with_saved_password'` when the winning password came from `resolveStatementPassword`, `'parsed_with_user_password'` when it came from `jarvis_memory` candidates, `'parsed_no_password'` when null. Signal passed through from `parseStatementPdfWithPasswords` (already returns `winning_password`).
- Purge-on-retry: at the top of the retry branch (line 541 `if (exSt)`), when `parse_status IN ('pending','failed','skipped')`, first run:
  - `DELETE FROM transactions WHERE source_statement_id = exSt.id;`
  - `UPDATE statements SET file_path=null, transactions_found=0, closing_balance=null, total_due=null, min_due=null, due_date=null, period_start=null, period_end=null, parser_source=null, parse_confidence=null, parser_confidence=null WHERE id = exSt.id;`
  - `DELETE FROM email_attachments WHERE statement_id = exSt.id AND attachment_type='statement';` (storage object left for GC; new upload uses `upsert:true`).

  Then continue with `ingestStatementAttachment`.

### Wave 2 — real per-bank PDF parsers

Replace the delegating stubs in `supabase/functions/_shared/statement-parsers/` with real bodies. Each file exports `<name>Parser: StatementParser` and returns a `ParserResult` with a bank-specific `parser_source` and `confidence >= 0.8` when it hits its anchor phrases.

Files to fill in (kept small — one anchor set per bank family, generic line extractor reused):

- `sbi-card.ts` (already stub) — anchors: `Statement Summary`, `Payment Due Date`, `Total Amount Due`, `Minimum Amount Due`, `MERCHANT NAME` / `TRANSACTION DETAILS`. Two-column CASHBACK/BPCL layouts, dates as `DD MMM YY`, amount trailing `D`/`C`. Emit `card_family` from subject (`CASHBACK`, `BPCL`).
- `hdfc-card.ts` — anchors: `Statement Date`, `Payment Due Date`, `Total Dues`, `Minimum Amount Due`, `Domestic Transactions` / `International Transactions` section headers; dates `DD/MM/YYYY`.
- `hdfc-account.ts` — anchors: `Statement From`, `Statement To`, `Closing Balance`, columns `Date | Narration | Chq/Ref No | Value Dt | Withdrawal Amt | Deposit Amt | Closing Balance`.
- `icici-card.ts` — anchors: `Statement Period`, `Total Amount due`, `Minimum Amount due`, `Transaction Details`; `DD/MM/YYYY`.
- `amazon-pay-icici.ts` — same as icici-card + `Amazon Pay ICICI Bank Credit Card` header; direction indicated by `CR` suffix.
- `icici-account.ts` — anchors: `Account Statement`, `Opening Balance`, `Closing Balance`, columns `DATE | MODE** | PARTICULARS | DEPOSITS | WITHDRAWALS | BALANCE`.
- `sbi-account.ts` — anchors: `Account Statement`, `Txn Date`, `Value Date`, `Description`, `Debit`, `Credit`, `Balance`.
- `axis-card.ts` + `airtel-axis` (share) — anchors: `Statement Period`, `Total Payment Due`, `Minimum Payment Due`, `Payment Due Date`, section `Transaction Details`.
- `yes-card.ts` — anchors: `YES BANK`, `Statement Date`, `Total Amount Due`, `Payment Due Date`.
- `kotak-card.ts` (new registry entry) — anchors: `Kotak Mahindra Bank`, `Total Amount Due`, `Payment Due Date`.

Each parser reuses `extractLines` from `generic.ts` but tightens it: passes a per-bank `dateFormat` hint and a column-count expectation. New helper `extractLinesForColumns(text, {cols, direction})` in `generic.ts` — biases toward the right column (debit vs credit) so account statements don't misclassify direction.

Registry (`index.ts`) picks these up automatically; add the two new banks and drop the `(generic)` suffix once wired.

### Wave 3 — Statements UI (`src/routes/finance/Statements.tsx`)

- Show `parse_error` and `parse_reason` distinctly under the status pill (`parse_error` is the machine code, `parse_reason` the human blurb). No more silent "PENDING" with empty status area.
- Row actions column: **View PDF** (existing `finance-statement-pdf-url`), **Retry parse** (calls `finance-retry-statement` which now purges + re-ingests), **Set password** (opens the existing password drawer), **Attach PDF** (only when `parse_error='no_pdf_attachment_login_required'`).
- Toolbar: **Retry all pending/failed** (batches to `finance-retry-statement`), **Re-sync mailbox** (calls `gmail-sync` for the 07statement account then `finance-extract`).
- Row density: fixed-height scroller `max-h-[calc(100vh-260px)] overflow-y-auto` + sticky header; remove the expanded inline "TOTAL DUE / CLOSING BALANCE / …" panel and move it to a click-through detail drawer to stop the current visual overlap.

### Wave 4 — clean up + verify

- `supabase--insert` to drop the duplicate cron job: `cron.unschedule('gmail-sync-due-15m')` (keeps `gmail-sync-due-every-15m`).
- One-off `supabase--insert` to kick a re-extract: for every user, invoke `finance-extract` for the 07statement account with `sinceDays=365` so all 21 stuck rows go through the fixed path. Also delete the 3 orphan `Unknown bank` statements that have `source_email_id IS NULL` (they can never be re-linked).
- Deploy the touched edge functions.
- Verify via SQL: `SELECT parse_status, parse_reason, count(*) FROM statements GROUP BY 1,2` should show real reasons (parsed / password_missing / password_failed / no_pdf_attachment_login_required) — no `NULL` rows.
- Playwright walk: open Statements, click **Retry all**, wait, screenshot; then open the SBI BPCL row → **View PDF**; then a HDFC row.

## Technical notes

- Keep parser modules framework-free (already done) so vitest can cover them; add `tests/statementParsers.test.ts` with 1 synthetic text per bank family asserting `parser_source`, `total_due`, `due_date`, `lines.length > 0`.
- Do not log plaintext passwords anywhere; `STATEMENT_ENC_SECRET` (already in secrets) is used by `saveWinningPassword` — verify the write path is invoked in the new purge-then-re-ingest flow.
- No migration needed. No new secrets needed.
- Sequencing: Wave 1 is what turns the current dark rows into actionable ones — even without the new parsers, the UI will start telling us exactly why each row isn't parsed. Waves 2–4 land on top without further schema churn.
