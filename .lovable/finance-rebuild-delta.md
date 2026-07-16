# Finance Rebuild — Delta Report (2026-07-13)

Records every destructive or structural change made during the "go all" pass.

## Migrations

- `20260713110000` (autogen id): added `transactions.detected_kind` (check-constrained enum) + partial index; `subscriptions.auto_detected boolean default false`; `financial_goals.funding_source_account_id`/`retirement_target`/`emergency_target_months`; created `public.detection_runs` with owner-scoped RLS + updated_at trigger.
- `tax_entries` was already present with `fiscal_year`/`regime`/`notes` — kept as-is; TaxCenter should consume those column names (no rename).

## Edge functions (new)

- `finance-detect` — regex classifier for `detected_kind`, merchant normalization, duplicate flagger (±3d, same normalized merchant + amount), suspicious-amount flagger (>5× 60d median), auto-creates monthly subscription when ≥3 same-amount charges/90d. Writes `detection_runs`. `verify_jwt=true`, sliding-window 6/min, `sanitizedErrorResponse`.
- `finance-reconcile` — matches expected sub/loan charges against transactions within ±2d and ±₹1. Emits `missing_charge` / `amount_mismatch` rows into `finance_alerts`. Idempotent per (entity, expected_date, status=open). `verify_jwt=true`, 6/min.
- `jarvis-finance-insight` — on-demand AI explainer. Zod-validated body; context wrapped in `<untrusted_data>`; Lovable AI Gateway (`openai/gpt-5.5`); 10/min.

Added `[functions.finance-detect]`, `[functions.finance-reconcile]`, `[functions.jarvis-finance-insight]` blocks to `supabase/config.toml` (all `verify_jwt = true`).

## Client wiring

- `src/lib/db.ts` `finance` namespace: added `detect()`, `reconcile()`, `insight(topic, context, question?)` helpers routing through `callEdgeFunction`.
- `src/routes/finance/CommandCenter.tsx` replaced the 8-line Overview wrapper with a real page: **Market strip** (reads `market_quotes`, refresh button hits `finance-market-sync`), **Quick actions rail** (Rescan email / Detect & classify / Reconcile / Refresh market — all wired to edge fns with toasts + snapshot invalidation), and the rich existing Overview composed below. No routes changed; `/finance` remains the entry point.

## Explicitly NOT done in this pass (still open)

- **Folder refactor** — plan called for `finance/{banking,investments,spending,planning,intelligence}/` folders. Current tree is flat; the 7-tab IA in `Finance.tsx` matches functionally. Not moved to avoid churning every import and every legacy route redirect.
- **`pg_cron` schedules** — 15m market-sync, 06:00 IST morning-brief, hourly detect/reconcile. Requires the project-specific function URL + anon key; a raw SQL insert (not a migration) is the right vehicle. Run manually from the SQL Editor per the `schedule-jobs-supabase-edge-functions` guide.
- **NSE-unofficial FII/DII fallback** and **market news RSS** — tables exist (`fii_dii_activity`, `market_news`) but the sync function only pulls Yahoo indices/FX/commodities today.
- **Groww PDF import path** — CSV path shipped; PDF path deferred.
- **Retirement projector with SWP** and **Emergency Fund gauge** — schema columns landed (`retirement_target`, `emergency_target_months`), UI not yet built. `financial_goals.funding_source_account_id` also unused in UI.
- **Investments benchmark vs Nifty50, risk score, diversification chart** — deferred.
- **Perf pass** (code-splitting, prefetch-on-hover, virtualization of Txns/Holdings) — deferred.
- **Duplicate/fraud badges** on Txns/Subs list rows — columns populated by `finance-detect`, but list UI does not yet render them.
- **`tax_entries` UI** in TaxCenter — table exists, page still computes from `taxCalc.ts` only.

## Pre-existing linter warnings (surfaced during this pass, not introduced)

- `0014_extension_in_public` — an extension is installed in `public` schema.
- Leaked-password protection is disabled in Supabase Auth. Toggle at Supabase → Auth → Providers → Password.

Both are user-side dashboard actions.
## 2026-07-16 · statement parser pass 3

Trigger: user reported "PARSED · INCOMPLETE / missing fields — auto re-scan queued" persisting across HDFC Millennia (FAILED · 0 txns), YES Klick (67 txns), Amazon Pay ICICI (2 txns), SBI Cashback/BPCL (0 txns) rows and provided the eight decryption passwords.

### Fixtures captured
Real password-protected PDFs saved under `tests/fixtures/statements/pdf/` (~3.5 MB total) with matching pdftotext-layout output under `tests/fixtures/statements/raw/`. These become the ground-truth regression set.

### Diagnosis (via pdfjs-serverless — the actual edge-fn extraction path)
- **HDFC Millennia** was the only real parser bug: the row-1 summary regex required BOTH `_` and `=` on the same line, but pdfjs emits `_` on its own line above `C -,196.33  C 0.00  +  C 7,655.26  +  C 0.00  = C 7,459.00`. Fix: `extractRow1` now finds any line with `=` and 3+ currency amounts, extracts total from the amount after `=`, and skips the "Past Dues / OVER LIMIT" bucket row. Result: total_due now populates.
- **Everything else** (SBI Cashback/BPCL, YES Klick, Amazon Pay ICICI, Axis, ICICI/Kotak accounts) parses `ok:true` with all required fields against pdfjs output. The rows still showing PARSED · INCOMPLETE in the UI are stale — they were parsed before earlier pass-1/pass-2 fixes shipped. A "Re-parse unresolved" click will converge them since the reparse loop, cool-down (30 min), attempt cap (5), and no-progress bail-out already ship.

### UI
`Statements.tsx` "missing fields" hint now lists the exact fields (from `parse_error: missing_fields:x,y,z` or derived from the row) with a hover title. No more generic "missing fields — auto re-scan queued" — the badge names statement_date/due_date/total_due/transactions individually.

### Tests
`tests/statementParsers.test.ts` gained a "captured real PDFs" describe block with one assertion per bank (8 tests) verifying statement_date, due_date, total_due, card_last4, and non-zero txn counts. Total: 33 tests, all green.

### Verified with existing pipeline
- Provided-password fast path (`finance-retry-statement` → `finance-extract-core.parseStoredStatementPdf` → `parseStatementPdfWithPasswords`) already prioritises `opts.password` before saved rule and `loadPasswordCandidates`, and auto-persists winning candidates via `saveWinningPassword`. No change needed.
- `finance-reparse-statements` already applies the unified cool-down + attempt cap; `remaining_after` and `throttled` counts already returned; `Statements.tsx reparseUnresolved` already bails on no-progress and single-toasts. No change needed.

### Files touched
- `supabase/functions/_shared/statement-parsers/hdfc-card.ts`
- `src/routes/finance/Statements.tsx`
- `tests/statementParsers.test.ts`
- `tests/fixtures/statements/pdf/*.pdf` (8 new)
- `tests/fixtures/statements/raw/*.txt` (8 new)
- `.lovable/finance-rebuild-delta.md`

### Explicitly NOT done
- No parser rewrite for banks already passing.
- No schema migration.
- No changes to Gmail sync, upload, or storage bucket policy.
