# Loans

> ✅ shipped · Phase 1 · P0 · `src/routes/finance/Loans.tsx`, `LoanDetail.tsx`, `src/lib/loanCalc.ts`

## 1. Purpose
Track every outstanding loan (personal, home, auto), its amortization,
payoff progress, and any EMI drift versus contractual EMI.

## 2. UI/UX Layout
```
┌ Loans ─────────────────────────────────────────────┐
│  ┌ HDFC Home Loan ── ₹42,10,000 outstanding ─┐     │
│  │ EMI ₹38,400 · 217 of 240 paid · 91%       │     │
│  └────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────┘
```
Detail: amortization table, EMI-hit tags on transactions.

## 3. User Journey
1. `/finance/loans` list.
2. Click → detail with schedule.
3. Config route to add/edit.

## 4. Database Schema
`loans(id, user_id, name, kind, principal, outstanding_amount,
interest_rate, tenure_months, emi_amount, start_date, next_due_date,
lender_bank_id, is_active, timestamps)`.

## 5. Supabase Tables
- `loans`, `banks`, `transactions` (EMI-hit backref).

## 6. Relationships
```
banks ──< loans
         └── linked_transactions (via loanCalc match)
```

## 7. Edge Functions
None. All computation client-side.

## 8. Business Logic
`loanCalc.ts` exports:
- `amortizationSchedule(principal, rateAnnual, tenureMonths, startDate)`
- `emiFromPrincipal(principal, rate, tenure)`
- `tagEmiHit(txn, loan)` → `±1%` tolerance vs `emi_amount`.

Invariant: sum of `principal_component` across schedule ≈ principal.

## 9. AI Logic
None. Reasoning is deterministic math.

## 10. Automation Rules
On new debit txn matching EMI amount ±1%, auto-tag `loan_id`.

## 11. Validation Rules
`principal > 0`, `tenure_months > 0`, `interest_rate ∈ [0, 40]`.

## 12. Error Handling
Amortization compute never throws; guards on 0 tenure.

## 13. Notifications
`finance_alerts` if `next_due_date` in <=5d and no matching txn found.

## 14. Analytics
`finance.loan.emi_missed`, `finance.loan.prepayment_detected`.

## 15. Security
RLS scoped. No PII beyond loan name.

## 16. API Flow
Static compute, no server calls.

## 17. State Management
`contentStore.financeVersion`.

## 18. Performance
Schedule for 360-month loan = 360 rows, computed in <5ms.

## 19. Mobile Behavior
Schedule paginated 24 rows; horizontal scroll for columns.

## 20. Desktop Behavior
Full schedule visible.

## 21. Future Enhancements
- Payoff simulator ("+₹5k/mo → -14 months").
- Interest-paid-to-date big number.

## 22. Acceptance Criteria + Test Cases
- **AC-1** Amortization for 20L @ 8.5% × 240 months → EMI ≈ ₹17,356.
- **AC-2** EMI-hit tag applied to matching debit within ±1%.
- Tests: `tests/loanCalc.test.ts` — EMI formula, schedule sum,
  prepayment scenario.
