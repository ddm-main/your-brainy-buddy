# Goals

> ✅ shipped · Phase 1 · P1 · `src/routes/finance/Goals.tsx`, `src/routes/config/GoalsConfig.tsx`

## 1. Purpose
Named savings targets ("Emergency fund ₹6L by 2027-01") with progress
and contribution log — turns diffuse "save more" into trackable outcomes.

## 2. UI/UX Layout
```
┌ Goals ──────────────────────────────────────────┐
│  ┌ Emergency fund ── ₹3.2L / ₹6.0L (53%) ─┐    │
│  │ ETA 2026-11 at current pace            │    │
│  └────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

## 3. User Journey
1. Config → create goal (target, target_date, linked_account).
2. Overview shows progress bar + ETA projection.
3. Contribute → adds contribution row + bumps `current_amount`.

## 4. Database Schema
`financial_goals(id, user_id, name, target_amount, current_amount,
target_date, linked_account_id, priority, timestamps)`.
Contributions logged in `next_actions` (repurposed) — see #22.

## 5. Supabase Tables
- `financial_goals`, `financial_accounts` (link).

## 6. Relationships
```
financial_accounts ──< financial_goals
```

## 7. Edge Functions
None.

## 8. Business Logic
- `progress = current_amount / target_amount`.
- `paceEta` = extrapolate from contribution history slope.

## 9. AI Logic
Advisor (Phase 5) reads goals to suggest contribution amounts.

## 10. Automation Rules
None. Manual contributions today.

## 11. Validation Rules
- `target_amount > 0`, `target_date > today`.
- `current_amount ∈ [0, target_amount]` (soft — allow over-fund).

## 12. Error Handling
Missing linked_account → allow, just skip source deduction.

## 13. Notifications
None routine. Milestone at 25/50/75/100% could push a toast (future).

## 14. Analytics
`finance.goal.created|contributed|reached`.

## 15. Security
RLS scoped.

## 16. API Flow
Direct supabase writes.

## 17. State Management
`contentStore.financeVersion`.

## 18. Performance
Tiny table.

## 19. Mobile Behavior
Full-width cards.

## 20. Desktop Behavior
Grid.

## 21. Future Enhancements
- Auto-contribute rule ("every salary credit +₹10k").
- Contribution history chart.

## 22. Acceptance Criteria + Test Cases
- **AC-1** Progress bar reflects `current/target` within 1%.
- **AC-2** ETA hides if <2 contributions recorded.
- Tests: none pure-lib today; add `tests/goals.test.ts` for `paceEta`.
