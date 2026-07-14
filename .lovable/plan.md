# Statements pipeline — build log

## Shipped this pass

### DB
- No schema migration needed. Columns `parse_reason`, `parser_source`, `parser_confidence` already existed; the code just wasn't writing them.
- Confirmed: only 1 gmail-sync cron exists (no duplicate to unschedule); 0 orphan `source_email_id IS NULL AND file_path IS NULL` statements to delete.

### Edge functions
- `supabase/functions/_shared/finance-extract-core.ts` — rewritten:
  - Every early-return in `ingestStatementAttachment` now persists `parse_error` + `parse_reason` (`gmail_payload_empty`, `attachment_download_failed`, `pdf_upload_failed`, `attachment_row_write_failed`, `attachment_row_missing`).
  - Top-level try/catch writes `ingest_crashed` reason.
  - "No PDF attachment" branch writes `parse_status='skipped', parse_reason='no_pdf_attachment_login_required'`.
  - `applyParsedStatementResult` success path writes `parser_source`, `parser_confidence`, `min_due`, `parse_reason` (`parsed_with_saved_password` / `parsed_with_user_password` / `parsed_no_password`).
  - Failure path writes human-readable `parse_reason` via `reasonForError()` map.
  - `extractFinanceForAccount` retry branch now also picks up `skipped` rows that have no reason (backfill).
  - New shared `purgeStatementDerivedData(svc, id, {keepStatementDate})` deletes derived txns + attachments + parsed fields, so retry is deterministic.
  - `.limit(1)` added to dedup lookup to avoid PGRST multi-row error.
- `supabase/functions/_shared/statement-pdf.ts` — added `min_due`, `bank`, `confidence` to `PdfParseResult`; extended `detectBank` to SBI, Yes, Kotak, AmEx; exports `detectBank`; `parseStatementText` returns bank + confidence.
- `supabase/functions/finance-retry-statement/index.ts` — calls `purgeStatementDerivedData` before re-ingest; passes `passwordSource` (`user` / `saved` / `none`) so `parse_reason` reflects which password worked.

### UI
- `src/routes/finance/Statements.tsx`:
  - Row status cell now shows `parse_reason` under the status chip (e.g. "no PDF · login-only alert").
  - Failure detail block shows `parse_error` (code) and `parse_reason` (human) as separate lines; password-family errors show a "provide password below" hint.
  - Skipped `no_pdf_attachment_login_required` rows show an inline note directing user to upload.
  - Toolbar: **retry N pending/failed** button batches through `finance-retry-statement`.
  - Fixed dead string match `wrong_or_missing_password` → real codes `password_required` / `wrong_password` / `stored_password_unreadable`.

### Data recovery
- Kicked `finance-extract` for the 07statement@gmail.com account with `since_days=365` via `net.http_post` so the 19 pending + 2 unlabeled skipped rows re-flow through the fixed path and land with a real `parse_reason`.

## Deferred (needs real PDF samples or is nice-to-have)

- **Per-bank parser module tree** (`statement-parsers/{sbi-card,hdfc-card,icici-card,...}.ts`). Current `genericFallback` handles most Indian statement boilerplate; tuning per-bank regexes without real sample PDFs would only add code without accuracy gain. Register when the first real statement is available.
- **Password-candidate helper** (try list of candidates from `jarvis_memory`, auto-save the winning one). Not blocking — user's saved password on the linked card/account already works via `resolveStatementPassword`.
- **DROP COLUMN `statements.parse_confidence`** (duplicate of `parser_confidence`). Follow-up migration.
- **"Re-sync mailbox" toolbar button** — user can already trigger via the Email config route.
- **Sticky-header + fixed-max-height table scroller** — cosmetic; drawer split not requested.

## Verification checklist

- `SELECT parse_status, parse_reason, count(*) FROM statements GROUP BY 1,2` — every row has a non-null `parse_reason` after the recovery run.
- Statements page shows a "retry N pending/failed" button when applicable; clicking it purges + re-ingests each row.
- Failed rows expand to show error code + human reason on separate lines.
- Skipped-no-PDF rows show the "upload directly" hint.
