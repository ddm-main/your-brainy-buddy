# Transactions

> 🟡 partial · Phase 1 · P0 · `src/routes/finance/Txns.tsx`
> Gaps: bulk actions, CSV export, learn-from-correction (Wave D-1).

## 1. Purpose
The single searchable ledger. Every debit/credit from every source
(statement, manual, email). Truth for every downstream metric.

## 2. UI/UX Layout
```
┌ Txns ──────────────────────────────────────────────────────┐
│ [date range] [type] [account] [category] [source] [recon]  │
│ [☐] [bulk: categorize | delete | mark recon | export CSV]  │  ← Wave D-1
│ ─────────────────────────────────────────────────────────  │
│ ☐ 2026-07-10 · Zomato        · Food   · ₹412  · HDFC …    │
│ ☐ 2026-07-09 · Salary Credit · Income · ₹1,80,000 · ICICI │
└────────────────────────────────────────────────────────────┘
Running total in header updates with filters.
```

## 3. User Journey
1. Filter → paginated list.
2. Inline edit category → dropdown, save on blur.
3. Bulk select → toolbar action (Wave D-1).
4. Export CSV → download respecting filters (Wave D-1).
5. Failure: mutation fails → row reverts, toast "not saved".

## 4. Database Schema
`transactions(id, user_id, account_id, amount, type, category,
merchant, description, date, source, statement_id, reconciled_at,
loan_id, subscription_id, timestamps)`.
Indexes: `(user_id, date desc)`, `(user_id, category)`,
`(user_id, statement_id)`.

## 5. Supabase Tables
- `transactions` (primary)
- `category_rules` (write on correction)
- `merchant_aliases` (write when merchant renamed)
- `statements`, `financial_accounts`, `loans`, `subscriptions`.

## 6. Relationships
```
financial_accounts ──< transactions >── statements
                                   >── loans (nullable)
                                   >── subscriptions (nullable)
```

## 7. Edge Functions
- Insert/update via direct supabase from client (RLS enforced).
- Bulk export computed client-side, no edge fn.

## 8. Business Logic
- `findPossibleDuplicate(txn)` — merchant + amount + date ±2d.
- `learnFromCorrection(txn, newCategory)` — writes
  `category_rules` row (merchant_normalized, category, source='user').

## 9. AI Logic
Category dropdown suggestions ranked by `categorize.score(txn)` which
reads `category_rules`.

## 10. Automation Rules
Detectors mark `loan_id`, `subscription_id` async.

## 11. Validation Rules
- `amount != 0`, `type ∈ {debit, credit}`.
- `category` non-empty; freeform allowed.
- `date` ≤ today + 1 (allow tomorrow's SI).

## 12. Error Handling
Bulk delete → confirm modal with count. Undo toast for 8s.

## 13. Notifications
Bulk actions: "12 txns categorised" toast.

## 14. Analytics
`finance.txn.bulk_categorize{n}`, `finance.txn.export_csv{n}`,
`finance.txn.corrected{category}`.

## 15. Security
RLS scoped. CSV is generated in the browser — no server round-trip
that could leak across users.

## 16. API Flow
```
UI change → supabase.update → refetch page → recompute running total
Bulk    → supabase.update in([...ids]) → refetch
Export  → csv.stringify(currentRows) → Blob download
```

## 17. State Management
Local component state for selection set. Global
`contentStore.financeVersion` bump on any mutation.

## 18. Performance
Page size 50. Server-side filter/order. Virtualize only if we ever go
past 500 rows in view.

## 19. Mobile Behavior
Filter bar collapses into a bottom sheet. Bulk toolbar becomes fixed
bottom bar.

## 20. Desktop Behavior
Sticky filter bar. `⌘A` selects visible page; `Shift+↓` extends
selection.

## 21. Future Enhancements
- Attachments per txn (receipt photo).
- Splits (one txn → many categories).

## 22. Acceptance Criteria + Test Cases
- **AC-1** Selecting 3 rows + bulk-categorize writes 3 updates and
  3 `category_rules` rows.
- **AC-2** CSV export contains only rows matching current filters.
- **AC-3** Inline category edit persists after reload.
- Tests: `tests/categorize.test.ts` — `score`, `learnFromCorrection`,
  and `tests/reconciliation.test.ts` for recon flag flow.
