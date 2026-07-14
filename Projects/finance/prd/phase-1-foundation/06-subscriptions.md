# Subscriptions

> ✅ shipped · Phase 1 · P1 · `src/routes/finance/Subs.tsx`, `src/lib/recurringDetector.ts`, `src/routes/config/SubscriptionsConfig.tsx`

## 1. Purpose
Every recurring charge — SaaS, OTT, memberships. Auto-detected from
transactions; user confirms into `subscriptions` for renewal alerts and
budgeting.

## 2. UI/UX Layout
```
┌ Subscriptions ─────────────────────────────────┐
│  Active (₹9,412 / mo)                          │
│  ┌ Netflix        ₹649 · monthly · next 07-18 │
│  ┌ Adobe CC       ₹4,208 · monthly · next 07-22
│                                                │
│  Suggested (from txns)                         │
│  ┌ Spotify        ₹119 · [confirm] [dismiss]  │
└────────────────────────────────────────────────┘
```

## 3. User Journey
1. Detector nightly builds candidates.
2. User confirms → row inserted in `subscriptions`.
3. Renewal 3d out → `finance_alerts` created.

## 4. Database Schema
`subscriptions(id, user_id, name, amount, cadence, next_renewal,
merchant, source_account_id, is_active, timestamps)`.

## 5. Supabase Tables
- `subscriptions`, `transactions` (source), `finance_suggestions`
  (candidate queue).

## 6. Relationships
```
transactions ──[detector]──> finance_suggestions ──[user accept]──> subscriptions
```

## 7. Edge Functions
- `finance-detect` (nightly cron) runs `recurringDetector` server-side.

## 8. Business Logic
`recurringDetector.ts`:
- Group by `normalizeMerchant(description)`.
- Require ≥3 hits, cadence stddev < 3d, amount stddev < 5%.
- Coverage window ≥ 90d.

## 9. AI Logic
None. Deterministic detector.

## 10. Automation Rules
`finance-detect` daily 02:00 UTC via pg_cron (Wave C-2).

## 11. Validation Rules
`amount > 0`, `cadence ∈ {weekly, monthly, quarterly, yearly}`.

## 12. Error Handling
Detector failure logged, no user surface.

## 13. Notifications
`finance_alerts` for renewals in ≤3d.

## 14. Analytics
`finance.sub.detected`, `finance.sub.confirmed`, `finance.sub.cancelled`.

## 15. Security
RLS scoped. Detector runs as service_role in edge fn, scoped by user_id.

## 16. API Flow
```
cron → finance-detect → recurringDetector → finance_suggestions insert
UI → confirm → subscriptions insert + suggestion status=accepted
```

## 17. State Management
`contentStore.financeVersion`.

## 18. Performance
Detector query indexed on `(user_id, date desc)`.

## 19. Mobile Behavior
Sections stack, dismiss via long-press.

## 20. Desktop Behavior
Two-column: active vs suggested.

## 21. Future Enhancements
- Cancellation assistant (draft email/action to unsubscribe).
- Category-level "why am I spending 4x on OTT" nudges.

## 22. Acceptance Criteria + Test Cases
- **AC-1** 3 monthly ₹649 Netflix txns → 1 suggestion.
- **AC-2** Confirming a suggestion creates exactly one subscription row.
- **AC-3** Renewal alert fires exactly once per cycle.
- Tests: `tests/recurringDetector.test.ts` — cadence, stddev,
  edge cases (missed month, amount drift).
