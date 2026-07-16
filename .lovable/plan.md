## Root cause of the retry error

The HDFC/Yes rows still show `parse_error='statement_update_failed'` with reason `Could not find the 'extracted_text' column of 'statements' in the schema cache`.

Verified against the live DB:

- `information_schema.columns` confirms `public.statements.extracted_text` **exists**.
- But every write in `applyParsedStatementResult` includes `extracted_text: …` in the same `UPDATE`, and PostgREST is still returning the "column not in schema cache" error. That means the **PostgREST schema cache was never reloaded** after the column was added, so every retry immediately re-fails at the final `statements.update(...)` and stamps `statement_update_failed` again.
- Your data-fix SQL (Wave A) resets the stale rows but does NOT reload the cache — so the very next retry writes the same error back in.

Two rows are currently stuck (HDFC Millennia `6560`, YES Klick `0337`); both have `file_path` + `source_email_id`, both are correctly linked to a credit card, both already have the last-4 stored in `manual_fields`.

## Status of prior plans

| Prior plan item | State |
|---|---|
| Wave 1 diagnostic `failStatement` on every early-return | Done |
| Wave 2 `purgeStatementDerived` on retry (keeps txns) | Done |
| Wave 3 password rotation + persist winning password | Done |
| Wave A1 data reconcile of `manual_fields.card_last4` + reset stale `statement_update_failed` | **Not run yet — this plan runs it** |
| Wave B1 keep-txns-on-retry | Done in `finance-retry-statement` (passes `keepTransactions: true`) |
| Wave B2 HDFC Millennia parser hardening | Not done |
| Wave B3 auto-link on suffix match inside `finance-extract-core` | Not done (only in manual-fields fn) |
| Wave B4 promote row-level retry + optimistic UI | Done |
| Wave B5 review panel auto-retry after save + max=4 | Done |
| Schema-cache reload | **Missing — this is the actual blocker** |

## New plan (DB first, then code)

### Wave 0 — Schema-cache reload (migration, DB-only, run first)

One tiny migration whose only job is to force PostgREST to re-introspect `public.statements`:

```sql
NOTIFY pgrst, 'reload schema';
```

Without this, every retry will keep writing `statement_update_failed` regardless of any other fix.

### Wave A — Data reconcile (migration, runs right after Wave 0)

Exactly the SQL you pasted, wrapped in a migration:

- For every statement whose linked `credit_cards.masked_number` has ≥ 4 digits, rewrite `manual_fields.card_last4` to the true last-4.
- For any row where `parse_error='statement_update_failed'` OR `parse_reason ILIKE '%extracted_text%'` OR `parse_reason ILIKE '%schema cache%'`, reset `parse_status='pending'`, clear `parse_error`, `parse_reason`, `learn_attempts=0`, `last_learn_at=null`.
- Transactions and stored PDFs untouched.

After Wave 0 + Wave A, clicking **Re-parse incomplete** on the two rows will actually succeed instead of re-stamping the same error.

### Wave B — Code hardening (single build, no schema changes)

**B1. Never let one bad column blow up the whole statement update** — `supabase/functions/_shared/finance-extract-core.ts` `applyParsedStatementResult`:
- On the terminal `statements.update(...).select("id").single()`, if `stErr` is a schema-cache error (`code === 'PGRST204'` or message mentions `schema cache`), retry ONCE after `svc.rpc('pgrst_reload', …)` **or** re-issue the same update with `extracted_text` stripped out (fallback — the row still gets the useful metadata; extracted_text is a cache, not required for UI).
- Only mark `statement_update_failed` after both attempts fail, and include the PostgREST `code` in `parse_reason` so future diagnosis is unambiguous.

**B2. Auto-link statements when only `card_last4` is known** — extend `finance-extract-core.ts` `resolveLinks` / final update path to run the same suffix-match logic that already lives in `finance-statement-manual-fields` (`digits(masked_number).endsWith(card_last4)`), so HDFC/YES rows with a clear last-4 get linked to their card on retry without any UI action.

**B3. HDFC Millennia parser hardening** — `supabase/functions/_shared/statement-parsers/hdfc-card.ts`:
- Fold standalone `l` / `●` marker lines into the preceding txn line before regex.
- Tolerate `C\s*2,505.46` and `C2,505.46` alike.
- Two-pass fallback: if strict `rowRx` finds < 2 rows but "Domestic Transactions" block exists, run a lax `date … amount` scan between that header and the next section header.
- Add unit test in `tests/statementParsers.test.ts` asserting ≥ 3 rows from `tests/fixtures/statements/raw/hdfc-millennia-jun2026-pdfjs.txt`.

**B4. UI cleanup** — `src/routes/finance/Statements.tsx`:
- Add `PGRST204` / `schema cache` codes to `explainParseError` so a future recurrence reads as "database cache out of date — reloading" instead of the current cryptic banner.
- Clear the optimistic-retry state even when the endpoint returns `parse_status='failed'` so the sticky "NEEDS RETRY" chip doesn't stack.

### Wave C — Verify

- `bunx tsgo --noEmit` clean.
- `bunx vitest run tests/statementParsers.test.ts` — new HDFC Millennia case green.
- Manual: `/finance/statements` → click **retry** on both HDFC 6560 and YES 0337 rows. Expect `parse_status='parsed'`, `parse_error=null`, txns column ≥ 3 for HDFC, banner gone.
- DB spot-check:
  ```sql
  select id, bank_slug, parse_status, parse_error, transactions_found
  from statements
  where id in ('31263a89-7c3c-4c96-a2cf-06c9172550bf','36219955-a080-417b-833a-06bf34d9bdab');
  ```

### Preview issue

Not a real bug — verified in a prior turn via Playwright: the preview iframe renders the `/auth` sign-in screen; the blank screenshot the user sees is the auth panel being scrolled outside the visible viewport. No code change needed. If you want, I can add a small tweak in `src/routes/Auth.tsx` to center the panel with `min-h-svh` + `grid place-items-center` so the form is always in view in narrow preview frames — say the word and I'll fold it into Wave B.

## Out of scope

- Schema changes to `statements`, `transactions`, `credit_cards`.
- Cron / gmail-sync-due changes.
- Full app-wide UI redesign from the earlier message.

I'll surface Wave 0 + Wave A migrations first for approval; Wave B code changes ship in the same build right after.
