# Statement pipeline — skeleton learning fix + card vs account split

## What I found in the current state

Deep-checked the DB and code paths:

- **0 rows in `statement_skeletons`** — no skeleton has ever been persisted, despite 26 parsed statements. Every statement row has `skeleton_id = null` and `learn_attempts = 0`.
- 21 of 26 statements are flagged `parse_status = parsed` but with **null** `statement_date`, `due_date`, and `total_due` — meaning the regex parser returned "ok" with an empty result, and no skeleton fallback ever ran to backfill.
- `runSkeletonFallback` only runs for freshly-parsed PDFs, not for the historical failures/incomplete rows already in the DB.
- `learn_attempts` and `last_learn_at` are never written by any code path, so we can't tell where the learner stalled.
- The regex parsers flatten PDF text with `join(" ")` — no positional data, so multi-column tables (transaction rows, "Statement Date … Payment Due Date" pairs) collapse into ambiguous strings. This is why HDFC/ICICI card statements land in "PARSED — INCOMPLETE".
- Card vs account is inferred late from links; when the statement email precedes the credit-card row being created, statements get typed as `card` and then fail the `due_date`/`total_due` requirement forever.

## What to build

### 1. Coordinate-aware PDF extraction (`statement-pdf.ts`)
- Keep `pdfjs.getTextContent()` output as `{str, x, y}` per item instead of a flat string.
- Group items into rows by `y` (tolerance 3px), sort rows top→bottom, sort items in a row left→right.
- Produce **two** outputs from every parse:
  - `text` (legacy joined string — parsers still consume this)
  - `rows: string[][]` — reconstructed row/column grid
- Detect header rows for transaction tables and map data cells to columns by nearest-x.

### 2. Skeleton learning that actually runs and persists
- Log `learn_attempts++` and `last_learn_at = now()` on every skeleton-fallback pass (success or fail) so we can see what happened.
- Trigger the fallback whenever ANY required field is null for the resolved `statement_type`, not just when `result.ok === false`.
- When `LOVABLE_API_KEY` is present, always try LLM learn on first sight of `(bank_slug, statement_type, layout_fingerprint)`. Wrap in a try and record the error in `parse_reason` instead of swallowing it.
- On upsert failure, surface the DB error to `parse_reason` (currently masked by `.catch(() => null)`).

### 3. Card vs account state machines
- Card statements track a lifecycle: `statement_date → due_date → total_due → min_due → paid_amount → payment_status`. Missing due/total keeps status = `pending`; the row becomes actionable in Command Center.
- Account statements are info-only: `statement_date`, `period_start/end`, `closing_balance`. Never mark them "INCOMPLETE" for missing due_date. `REQUIRED_FIELDS_BY_TYPE` already separates these but the UI still shows accounts as INCOMPLETE — fix the derived status in `Statements.tsx`.
- Loan statements: `statement_date`, `emi_amount`, `principal_outstanding`, `next_emi_date` — currently unhandled; treat as info-only for now, add a TODO.

### 4. Skeleton reuse fast-path
- After learn, `applySkeleton` returns values on subsequent statements without another LLM call. Verify by rerunning `finance-reparse-statements` on 3 historical HDFC card statements and confirming skeleton_id populates on all 3, LLM is called only once.
- Add a `force_relearn` flag on the Statements UI (per-row action) so a bad skeleton can be busted.

### 5. Retro-repair job
- One-shot Edge Function `finance-relearn-skeletons` that iterates statements where `parse_status='parsed'` but core fields are null, downloads the PDF, and reruns `runSkeletonFallback`. Report a summary at the end.

### 6. UI cleanup on `Statements.tsx`
- Show `INCOMPLETE` only when `statement_type='card'` and (due_date is null OR total_due is null).
- Add a small column showing `skeleton_id` presence (a "learned" badge) so it's visible when the fast path is active.
- Add per-row "Relearn skeleton" action.

## Files to change

```text
supabase/functions/_shared/statement-pdf.ts            # coord extraction + rows
supabase/functions/_shared/statement-skeleton.ts       # log attempts, LLM error surface, structural retry
supabase/functions/_shared/finance-extract-core.ts     # trigger fallback on missing fields, bump learn_attempts
supabase/functions/_shared/statement-parsers/*.ts      # consume rows[] for HDFC/ICICI/AXIS/SBI cards
supabase/functions/finance-relearn-skeletons/index.ts  # new retro-repair
src/routes/finance/Statements.tsx                      # status logic + relearn action + learned badge
```

## Verification

- `bunx vitest run tests/statementSkeleton.test.ts tests/statementParsers.test.ts` — extend with a coord-based fixture and a "second statement uses cached skeleton" test.
- Read `statement_skeletons` after a reparse — expect ≥1 row per (bank, type) touched.
- Read `statements` — expect 0 rows with `statement_type='card' AND parse_status='parsed' AND due_date IS NULL` after the retro-repair job.

## Not included (call out)

- No changes to storage-bucket layout or password rotation.
- No new bank parsers beyond the four already registered — coord extraction should lift them without new regex.
- Loan-statement parsing stays at today's level (info only, no EMI schedule extraction) — flagged as follow-up.
