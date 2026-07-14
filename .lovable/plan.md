## Plan

### 1. Open statement PDFs inside the app
- Replace `window.open(url, "_blank")` on the Statements page with an in-app PDF overlay/modal.
- Reuse the signed private PDF URL but render it in an embedded viewer with:
  - close button
  - open/download fallback link
  - loading/error state
- Ensure row clicks do not accidentally expand/collapse when opening the PDF from the table or expanded row.

### 2. Fix the current edge function syntax/runtime issue
- Clean up `supabase/functions/finance-reparse-statements/index.ts`; the file currently has a duplicated trailing `catch`/`Deno.serve` closure after the real handler.
- Keep the small-batch reparse behavior, but reduce the edge-worker wall-clock deadline to a safer value so it exits before resource limits.

### 3. Fix SBI statement parsing against the real extracted text
- Update the SBI card parser to handle the actual PDF text shape already stored in `email_attachments.extracted_text`:
  - labels and values split across adjacent lines, e.g. `*Total Amount Due` then `2,444.00`
  - `Statement Date` / `Payment Due Date` values appearing in table-like rows
  - statement period text like `for Statement Period: 02 Aug 25 to 01 Sep 25`
  - transaction rows using `D` / `C` instead of only `Dr` / `Cr`
  - two-digit years such as `01 Sep 25`
- Prevent false-success rows: if due date / statement date / total due / transactions are missing, keep the row failed or low-confidence instead of marking it `parsed` with blanks.

### 4. Improve transaction population and categorization
- Insert statement transactions with the raw line `description` populated, not only `merchant`.
- Store normalized merchant text where available.
- Expand deterministic categorization for observed merchants and common Indian card-statement text, including online shopping, food delivery, utilities, fuel, cashback/refunds, EMI/fees/charges, subscriptions, healthcare, travel, groceries, cash/ATM.
- Preserve idempotency: re-parsing a statement should replace only that statement’s derived transactions and avoid duplicating matching email-alert transactions.

### 5. Add regression coverage
- Extend `tests/statementParsers.test.ts` with a real-shape SBI fixture from the database sample:
  - total due `2444`
  - minimum due `200`
  - statement date `2025-09-01`
  - due date `2025-09-21`
  - period `2025-08-02 → 2025-09-01`
  - cashback credit plus debit purchase rows parsed correctly
- Add cases for `D/C` line suffixes and label/value-split totals.

### 6. Reprocess existing bad rows after deployment
- After code changes, use the existing small-batch “re-parse unresolved” path or temporarily target rows with `parser_source like 'sbi-card% → generic fallback'` so the 21 existing SBI rows are refreshed.
- Validate in Supabase that parsed SBI rows now have dates, totals, and statement-derived transactions.

## Technical notes
- Main files to change:
  - `src/routes/finance/Statements.tsx`
  - `supabase/functions/finance-reparse-statements/index.ts`
  - `supabase/functions/_shared/statement-parsers/sbi-card.ts`
  - `supabase/functions/_shared/statement-parsers/generic.ts`
  - `supabase/functions/_shared/finance-extract-core.ts`
  - `tests/statementParsers.test.ts`
- No schema migration is required for this pass; the needed columns already exist (`transactions.description`, `transactions.merchant_normalized`, statement parse fields, private PDF bucket path).