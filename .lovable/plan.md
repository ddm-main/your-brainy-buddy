Deepak, here is the exact production-fix plan for the Statements section.

## Current audit result

### Completed already
- Statement section UI exists with:
  - mailbox fetch
  - card/account/loan tabs
  - status filters
  - unlinked filter
  - PDF viewer
  - retry per row
  - bulk re-parse incomplete action
  - manual upload/attach flow
- Real bank parsers exist for:
  - YES Bank card
  - HDFC card
  - Axis/Airtel Axis card
  - ICICI/Amazon Pay ICICI card
  - SBI card
  - ICICI/Kotak/SBI/HDFC account variants
- Secure PDF handling exists:
  - private `statement-pdfs` bucket
  - server-side password attempts
  - saved/candidate password support
  - signed PDF viewer URLs
- Database now has the key statement columns:
  - `bank_slug`
  - parser/source/confidence fields
  - skeleton metadata
  - payment lifecycle fields
- Existing parser fixtures already cover many real statement formats.

### Remaining live issues found
- `21` card statements are still incomplete.
- `5` statements are unresolved (`failed` or `skipped`).
- `2` card rows are unlinked to a saved card.
- `bank_slug` is still empty on every live statement row even though banks are linked elsewhere.
- Old skeletons are still present with older parser versions and bad outcomes:
  - HDFC skeleton: `138` failures, `0` successes.
  - SBI skeletons are still version `2` while parser version is `3`.
- HDFC Millennia is stuck with `learn_attempts = 140`, which means the auto-retry cap/cooldown logic is not cleaningly preventing churn for already-broken rows.
- Several rows show `parsed` but are functionally incomplete because required card fields are missing.
- The statement list is surfacing technical statuses (`parsed_with_user_password`, `skeleton learned`, raw missing fields) instead of a clear next action.

## Root causes to fix

1. **Forwarded email sender problem**
   - Many statements come from `ddongarecc@gmail.com`, so sender-based bank detection fails unless subject/PDF detection wins everywhere.
   - The code has detection helpers, but the live rows prove `bank_slug` is not being persistently written or backfilled.

2. **Stale/bad skeleton reuse**
   - Skeleton rows from older parser versions remain in the database.
   - HDFC has a bad learned skeleton repeatedly failing and poisoning retries.

3. **Incomplete parsed rows are treated inconsistently**
   - Some rows are `parse_status='parsed'` while missing required card fields.
   - The UI labels these as incomplete, but backend status remains ambiguous.

4. **Auto-reparse convergence is weak**
   - The HDFC row has 140 learn attempts despite caps intended to stop retry churn.
   - Bulk reparse can still feel like it “does something” while leaving the same visible errors.

5. **Manual link/retry is not enough**
   - HDFC and YES rows are unlinked even though matching cards exist by bank + card suffix/name.
   - The link resolver needs stronger subject/PDF-based matching for forwarded statements.

6. **Parser output mismatch on live PDFs**
   - Fixtures pass in tests, but live extracted text still fails for HDFC, YES, Amazon Pay ICICI, and SBI month rows.
   - That means the parser must be validated against stored live extracted text, not only static fixtures.

## Implementation plan

### 1. Add a statement health/audit query path
- Add backend-safe helper logic to classify each statement into:
  - healthy parsed card
  - parsed but incomplete
  - unlinked
  - failed parser
  - skipped/no PDF
  - stale skeleton blocked
- Use this classification for both the UI and reparse targets so counts match what the user sees.

### 2. Fix bank detection and persistence
- Ensure every parse path writes `bank_slug` from the strongest available signal:
  1. explicit row value
  2. saved linked bank/card/account
  3. subject
  4. original sender
  5. PDF text
- Backfill existing rows from subject/link/PDF-derived signals.
- Normalize slugs consistently:
  - `yes bank`
  - `hdfc`
  - `sbi`
  - `amazon-pay-icici`
  - `airtel-axis`
  - `icici`
  - `kotak`

### 3. Fix card/account linking for forwarded statements
- Update link resolution so forwarded statements match by:
  - card last digits from PDF
  - bank slug
  - subject tokens (`Millennia`, `Amazon Pay`, `Cashback`, `BPCL`, `Airtel`, `Klick`)
  - saved card bank/name
- Backfill currently unlinked card rows where confidence is high.
- Preserve manual overrides if a row was explicitly linked by the user.

### 4. Purge or invalidate stale/bad skeletons
- Delete or supersede skeletons below current parser version.
- Disable skeletons with repeated failures and zero successes.
- Stop skeleton fallback from overriding good regex fields with null/weak learned values.
- Reset runaway `learn_attempts` only after the stale skeletons are cleared.

### 5. Harden parsers using live stored extracted text
- Pull the extracted text from stored statement attachments where available.
- Add/adjust parser tests for each failing live class:
  - HDFC Millennia June 2026
  - YES Bank Klick July 2026
  - Amazon Pay ICICI June/July 2026
  - SBI Cashback/BPCL monthly statements from 2025
- Fix parser gaps until these produce required fields:
  - `statement_date`
  - `due_date`
  - `total_due`
  - `transactions_found > 0` where the PDF contains line items
  - correct `card_last4`

### 6. Make “parsed but incomplete” a real backend state
- Keep `parse_status='failed'` or a clear `parse_error='missing_fields:...'` when required card fields are missing.
- Avoid showing `parsed` for a card that cannot drive billing/payment lifecycle.
- Preserve partial extracted fields so rows still show useful info.

### 7. Fix reparse-all convergence
- Make bulk reparse operate only on actionable rows.
- Return separate counts:
  - fixed
  - still missing fields
  - skipped/no PDF
  - needs manual password/link
  - capped/stale skeleton blocked
- Stop repeating retries for rows already known to be unfixable without user input.
- Surface a precise toast and row-level next action.

### 8. Clean up Statements UI messaging
- Replace noisy technical messages with clear states:
  - “Needs parser fix”
  - “Needs PDF attach”
  - “Needs card link”
  - “Password failed”
  - “Parsed successfully”
- Keep diagnostic detail available in expanded row, not in the main table.
- Add a compact “Repair status” summary above the table:
  - Healthy
  - Incomplete
  - Unlinked
  - Needs PDF

### 9. Data repair pass
- After parser/link fixes, run a controlled repair:
  - invalidate stale skeletons
  - backfill bank slugs
  - backfill confident card/account links
  - reparse incomplete rows in batches
  - verify remaining failures are truly manual-action items

### 10. Verification
- Run targeted parser tests.
- Test the edge functions:
  - `finance-reparse-statements`
  - `finance-retry-statement`
  - `finance-statement-pdf-url`
- Re-query live DB and verify:
  - incomplete card count drops materially, ideally to `0` except rows needing PDF/manual data
  - no rows show `parsed` while missing required card fields
  - bank slugs are populated
  - no stale skeletons remain active
  - the UI count matches backend repair classification

## Required database changes

Likely small data/schema maintenance only:
- Add optional `repair_status` / `repair_reason` only if the existing `parse_status + parse_error + parse_reason` fields are not enough.
- Add indexes if needed for statement repair queries:
  - user + parse status
  - user + statement type + incomplete fields
  - statement attachments by statement id
- Use migration tool for schema/index changes.
- Use data-change tool for backfills/cleanup after code is ready.

## Definition of done

- The Statements page no longer shows “Unknown bank” for rows where bank can be inferred.
- Rows linked to known cards show the card name consistently.
- “Re-parse incomplete” converges and stops with an honest result.
- HDFC/YES/Amazon ICICI/SBI rows either parse fully or show a specific manual action.
- No active stale skeleton is repeatedly failing.
- Main table is readable: operational statuses first, diagnostics second.
- Live DB audit confirms the remaining count is real, not parser/system noise.