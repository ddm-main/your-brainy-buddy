# Credit Cards

> ✅ shipped · Phase 1 · P0 · `src/routes/finance/Cards.tsx`, `CardDetail.tsx`, `src/routes/config/CardsConfig.tsx`

## 1. Purpose
Track every credit card, its cycle, limit, current utilization, latest
statement, and unpaid dues. Utilization feeds health score; dues feed
upcoming-bills.

## 2. UI/UX Layout
```
┌ Cards ──────────────────────────────────────────────┐
│  ┌ HDFC Millennia ──────── ₹18,400 / ₹1,50,000 ┐    │
│  │ util ring 12% · due 2026-07-25 · min ₹1,200 │    │
│  └──────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```
Detail view: utilization ring (SVG), latest statement summary, txn list.

## 3. User Journey
1. `/finance/cards` → grid of cards.
2. Click card → `/finance/cards/:id` → statement history + txns.
3. Config route: add/edit/delete card, set cycle day, limit.

## 4. Database Schema
`credit_cards(id, user_id, bank_id, name, last4, credit_limit,
current_balance, statement_day int, due_day int, min_payment numeric,
apr numeric, is_active, timestamps)`.

## 5. Supabase Tables
- `credit_cards`, `banks`, `statements`, `transactions`.

## 6. Relationships
```
banks ──< credit_cards ──< statements ──< transactions
```

## 7. Edge Functions
Statement parsing goes through `finance-extract` +
`finance-summarize-statement` (see #08 spec).

## 8. Business Logic
- `utilization = current_balance / credit_limit`.
- `daysToDue = due_day - today`.
- Contributes to `calcHealthScore` via `utilization` weight.

## 9. AI Logic
None on card itself; card statement handled by parser + summarizer.

## 10. Automation Rules
Statement fetched from Gmail sync → parsed → `current_balance` updated.

## 11. Validation Rules
- `last4` exactly 4 digits.
- `credit_limit > 0`, `current_balance >= 0`.
- `statement_day` and `due_day` 1..31.

## 12. Error Handling
If parsed `current_balance > credit_limit` → warn banner, don't block
save.

## 13. Notifications
`finance_alerts` when `daysToDue <= 3` and `current_balance > 0`.

## 14. Analytics
`finance.card.viewed{id}`, `finance.card.high_util{util}`.

## 15. Security
RLS scoped. `last4` is not full PAN; full PAN is never stored.

## 16. API Flow
```
Cards → supabase.from('credit_cards').select
     → CardDetail → statements + transactions parallel
```

## 17. State Management
`contentStore.financeVersion`.

## 18. Performance
Utilization ring drawn with SVG, no chart lib. Statement history
paginated at 12.

## 19. Mobile Behavior
Cards stack; ring shrinks to 56px.

## 20. Desktop Behavior
Grid of 3 columns at 1440px.

## 21. Future Enhancements
- Historical utilization trend (needs `card_balance_history`).
- Reward-points tracking per card.

## 22. Acceptance Criteria + Test Cases
- **AC-1** Utilization ring accurate to 1%.
- **AC-2** Alert fires exactly once per cycle when `daysToDue <= 3`.
- **AC-3** Editing limit recomputes util immediately.
- Tests: covered via `financeMetrics.test.ts::calcUtilization`.
