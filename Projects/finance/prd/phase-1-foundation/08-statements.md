# Statements

> ✅ shipped · Phase 1 · P0 · `src/routes/finance/Statements.tsx`, `supabase/functions/finance-*`

## 1. Purpose
Upload / auto-ingest bank + card statements (PDF), extract every
transaction, reconcile against ledger, keep the PDF searchable.

## 2. UI/UX Layout
```
┌ Statements ──────────────────────────────────────────────┐
│ [+ upload]  [filter: account]                            │
│  2026-06 HDFC Card · 42 txns · ₹18,400 due · [open PDF]  │
│  2026-06 ICICI SB  · 61 txns · balance ₹4,21,300         │
└──────────────────────────────────────────────────────────┘
```
Drill-in: parsed txn table + AI summary + validation banner.

## 3. User Journey
1. Upload PDF → edge fn extracts.
2. Parser fails on password → prompt password → retry.
3. Parsed → txns inserted, reconciliation runs, alerts if variance.
4. Click statement → detail with summary + txn list.

## 4. Database Schema
`statements(id, user_id, account_id|card_id, period_start, period_end,
opening_balance, closing_balance, total_due, min_due, due_date,
pdf_path, status, parse_error, summary_md, timestamps)`.

## 5. Supabase Tables
- `statements`, `transactions` (children), `reconciliation_matches`,
  `finance_alerts`.

## 6. Relationships
```
statements ──< transactions
statements ──< reconciliation_matches
```

## 7. Edge Functions
- `finance-upload-statement` — signed URL, stores in `statement-pdfs`.
- `finance-extract` — parses PDF via `_shared/statement-pdf.ts` +
  `_shared/finance-parsers.ts`.
- `finance-retry-statement` — re-runs extract with password.
- `finance-summarize-statement` — LLM summary via `brain-router`.
- `finance-statement-pdf-url` — issues short-TTL signed URL.
- `finance-set-statement-password` — encrypts + saves.

Secrets: `STATEMENT_ENC_SECRET`, `LOVABLE_API_KEY`.

## 8. Business Logic
- Validation: `abs(sum(txn debits) - total_due) < 1` else warn.
- Reconciliation: match parsed txns to existing debits by
  amount+date±2d+merchant.

## 9. AI Logic
`finance-summarize-statement` → `brain-router` → Gemini flash by
default. Output: 3-bullet summary (spend delta, unusual charge,
utilization change).

## 10. Automation Rules
Gmail sync auto-triggers `finance-upload-statement` when a statement
attachment is detected via `finance_email_rules`.

## 11. Validation Rules
- File ≤ 15MB.
- MIME `application/pdf`.
- Zod on parsed output: opening/closing numeric, txns array.

## 12. Error Handling
- Password-required → `status='needs_password'`, banner surfaces.
- Parse error → `status='failed'`, `parse_error` shown, retry button.

## 13. Notifications
`finance_alerts` on variance > ₹100 between statement total and ledger.

## 14. Analytics
`finance.statement.uploaded`, `finance.statement.parse_failed`,
`finance.statement.reconciled{variance}`.

## 15. Security
- PDFs in private bucket `statement-pdfs`.
- Signed URLs only after RLS check by edge fn.
- Password AES-256-GCM (`STATEMENT_ENC_SECRET`).
- Wrapped in `<untrusted_data>` before LLM.

## 16. API Flow
```
Upload → finance-upload-statement (signed URL)
       → PUT to storage
       → finance-extract (parse + insert txns)
       → reconciliation
       → finance-summarize-statement
```

## 17. State Management
`contentStore.financeVersion`. Upload progress local state.

## 18. Performance
Extract fn budget 30s. Summarize fn budget 15s.

## 19. Mobile Behavior
Upload via file picker; PDF viewer via native.

## 20. Desktop Behavior
Drag-and-drop zone.

## 21. Future Enhancements
- Multi-file drag drop.
- OCR fallback for scanned statements.

## 22. Acceptance Criteria + Test Cases
- **AC-1** Uploading a known-good HDFC PDF creates the statement row +
  N txns matching parser output.
- **AC-2** Password-protected PDF prompts, then extracts on retry.
- **AC-3** Variance > ₹100 raises a `finance_alerts` row.
- Tests: `tests/reconciliation.test.ts`.
