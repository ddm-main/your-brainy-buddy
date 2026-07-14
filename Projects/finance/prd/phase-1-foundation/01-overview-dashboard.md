# Overview Dashboard

> ✅ shipped · Phase 1 · P0 · `src/routes/finance/Overview.tsx`, `useFinanceSnapshot.ts`, `financeMetrics.ts`

## 1. Purpose
One glance answer to "am I okay financially today". Net worth, health
score, credit utilization, category spend, upcoming bills, 6-month
trend, active alerts — all above the fold, no scrolling to find "the
number that matters".

## 2. UI/UX Layout
```
┌─ KPI row ────────────────────────────────────────────────┐
│ Net Worth │ Health │ Utilization │ Savings Rate │ Δ 30d │
├─ Alerts (finance_alerts, unread) ────────────────────────┤
├─ Category spend (top 6, MTD) │ Trend (6mo bar)  │
├─ Upcoming bills (next 14d)   │ Goal projections │
├─ AI take (brain-router)      │ Budget widget    │  ← Wave D-2
└─ Suggestions drawer trigger ─────────────────────────────┘
```
Wrapped in `HudPanel`. Numbers animated via `KineticNumber`.

## 3. User Journey
1. Home → `/finance` → snapshot loads in <400ms, KPI cards animate in.
2. Click category chip → routes to `/finance/txns?category=food`.
3. Click alert → drawer opens with reconciliation candidates.
4. Failure: snapshot fetch fails → HUD shows dim "signal degraded" + retry.

## 4. Database Schema
Read-only aggregation across `financial_accounts`, `credit_cards`,
`loans`, `financial_goals`, `subscriptions`, `transactions`,
`finance_alerts`, `budgets`, `finance_suggestions`.

## 5. Supabase Tables
- `financial_accounts.current_balance` — net worth positive side.
- `credit_cards.current_balance, credit_limit` — utilization.
- `loans.outstanding_amount` — debt.
- `transactions.amount, type, category, date` — trend/category spend.
- `finance_alerts.status='unread'` — banner count.

## 6. Relationships
```
Overview
 ├── financial_accounts (user_id)
 ├── credit_cards       (user_id)
 ├── loans              (user_id)
 ├── financial_goals    (user_id)
 ├── transactions       (user_id, account_id → *)
 ├── finance_alerts     (user_id)
 └── budgets            (user_id, category)
```

## 7. Edge Functions
None directly. `jarvisChat` used for "AI take" one-shot (to be replaced
by `finance-chat` in Wave D-2).

## 8. Business Logic
`useFinanceSnapshot()` — hook, batches 8 queries with `Promise.all`,
computes:
- `calcNetWorth(accounts, cards, loans)`
- `calcHealthScore({savingsRate, util, reliability, debtRatio})`
- `calcUtilization(cards)`
- `topCategories(txns, 6, 'mtd')`
- `sixMonthTrend(txns)`

## 9. AI Logic
Model: `google/gemini-2.5-flash` via `brain-router` (finance branch).
Prompt: snapshot JSON + last 30 txns, ask for 3-bullet take. Output
plain text ≤400 chars.

## 10. Automation Rules
None. Recomputed on mount + on `contentStore.financeVersion` bump.

## 11. Validation Rules
Snapshot fields all nullable — UI must render "—" for null KPIs.

## 12. Error Handling
Any query fails → the specific tile shows "—" and a retry chip; other
tiles keep rendering. No full-panel crash.

## 13. Notifications
Unread `finance_alerts` count shown in the alerts strip. Snapshot
refresh does not toast on success.

## 14. Analytics
`finance.overview.viewed`, `finance.overview.tile_clicked{tile}`,
`finance.overview.ai_take_requested`.

## 15. Security
All queries scoped by RLS to `auth.uid()`. No aggregate leaks to other
users possible. AI take sends only aggregated numbers + merchant names,
no raw account numbers.

## 16. API Flow
```
Overview mount
 → useFinanceSnapshot()
   → 8× supabase.from(...) parallel
   → compute in worker-free lib
 → render KineticNumber tiles
```

## 17. State Management
`contentStore.financeVersion` — bumped by any mutation elsewhere,
triggers snapshot refetch. No React-Query today (direct supabase +
useState); keys will be `['finance','snapshot',userId]` when migrated.

## 18. Performance
Snapshot cost: 8 queries, all indexed on `user_id`. Budget: <500ms p95.
Guard N+1 by never fetching per-txn joins here — joins live in Txns.

## 19. Mobile Behavior
`<1024px` — grid collapses to single column; trend chart hidden below
`<640px`.

## 20. Desktop Behavior
Occupies main HUD content slot. Shortcuts: `g o` → overview, `g t` →
txns.

## 21. Future Enhancements
- BudgetWidget + SuggestionsDrawer mount (Wave D-2).
- Replace `jarvisChat` with streaming `finance-chat`.
- Cache snapshot in `sessionStorage` for instant paint.

## 22. Acceptance Criteria + Test Cases
- **AC-1** All 5 KPI tiles render within 500ms of route mount.
- **AC-2** Failing one query does not blank the panel.
- **AC-3** Clicking a category chip navigates with filter applied.
- Tests: `tests/financeMetrics.test.ts` — `calcNetWorth`,
  `calcHealthScore`, `topCategories`, `sixMonthTrend`.
