# Auto Statement Parser

> ✅ shipped · Phase 2 · P0 · `supabase/functions/finance-extract/`, `_shared/statement-pdf.ts`, `_shared/finance-parsers.ts`

## 1. Purpose
Turn an opaque PDF into structured transactions in one call. No human
row-typing.

## 2. UI/UX Layout
Backend module — surfaced through Statements UI (see spec 08).

## 3. User Journey
1. PDF uploaded → `finance-extract` invoked.
2. If password-required → 428 back to UI → user enters → retry.
3. On success → txns written, statement summary generated.

## 4. Database Schema
Writes to `statements` (status, opening/closing/due, summary) and
`transactions` (batch insert).

## 5. Supabase Tables
`statements`, `transactions`, `finance_alerts` (on variance).

## 6. Relationships
See spec 08 ERD.

## 7. Edge Functions
`finance-extract` — POST, `verify_jwt=true`. Body: `{statement_id}`.
Response: `{ok, txn_count, warnings[]}`.
Uses `_shared/finance-extract-core.ts` router that picks a parser from
`_shared/finance-parsers.ts` by issuer heuristic.

## 8. Business Logic
- Text extraction via `pdfjs` in `_shared/statement-pdf.ts`.
- Parser table by issuer regex (HDFC, ICICI, Axis, SBI, AmEx …).
- Normalisation: date → ISO, amount → paise-safe number, description →
  trimmed.
- Sanity: `Σ debits + Σ credits ≈ closing - opening`.

## 9. AI Logic
Fallback path: if no deterministic parser matches, `finance-extract`
calls the LLM with the raw text wrapped in `<untrusted_data>` and asks
for a JSON array. Model: Gemini flash via `brain-router` cost branch.

## 10. Automation Rules
Called synchronously after upload, and by `gmail-sync-due` when an
email attachment matches a `finance_email_rules` row.

## 11. Validation Rules
Zod `TxnSchema = z.object({date: iso, amount: number, type: enum,
description: string})`. Reject rows failing schema; log to `warnings`.

## 12. Error Handling
- `password_required` (structured error).
- `parser_not_found` → falls to LLM path.
- `llm_low_confidence` (< 0.6 avg) → `status='needs_review'`.

## 13. Notifications
Failure → `finance_alerts` "statement parse failed".

## 14. Analytics
`finance.parse.ok{issuer,n}`, `finance.parse.fallback_llm{issuer}`,
`finance.parse.failed{reason}`.

## 15. Security
`verify_jwt=true`. PDF read from private bucket with service_role. LLM
input wrapped in `<untrusted_data>`.

## 16. API Flow
```
UI → finance-extract → parser(regex) or LLM → txn rows → statements.status=parsed
```

## 17. State Management
Statement row status transitions: `uploaded → parsing → parsed | failed | needs_password`.

## 18. Performance
Budget 30s. Typical: 3-8s for 60-txn statement.

## 19. Mobile Behavior
N/A backend.

## 20. Desktop Behavior
N/A backend.

## 21. Future Enhancements
- OCR path (scanned statements).
- Per-issuer accuracy telemetry to promote/demote parsers.

## 22. Acceptance Criteria + Test Cases
- **AC-1** Golden HDFC PDF → exact txn count expected.
- **AC-2** Password PDF returns `password_required`.
- **AC-3** LLM fallback triggers when no parser matches.
- Tests: fixture-based parser tests (add `tests/parsers.test.ts`).
