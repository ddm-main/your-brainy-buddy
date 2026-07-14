# Accounts

> ✅ shipped · Phase 1 · P0 · `src/routes/finance/Accounts.tsx`, `src/routes/config/AccountsConfig.tsx`

## 1. Purpose
The registry of every place money sits — checking, savings, brokerage,
wallets. Feeds net worth, cash flow, reconciliation.

## 2. UI/UX Layout
```
┌ Accounts ─────────────────────────────────────┐
│ [+ new]                                       │
│  ┌ ICICI Savings ──────── ₹4,21,300 ─ 🟢 ─┐   │
│  │ last synced 2h ago · 42 txns MTD       │   │
│  └────────────────────────────────────────┘   │
└───────────────────────────────────────────────┘
```

## 3. User Journey
1. `/finance/accounts` → list of accounts with balances.
2. Click account → drills into filtered `Txns` view.
3. Config route: add/edit/delete accounts, set statement password.
4. Failure: balance-fetch fails → dim row + "refresh" chip.

## 4. Database Schema
`financial_accounts(id uuid pk, user_id uuid, bank_id uuid, name text,
type text, current_balance numeric, currency text, statement_password_ct
text, is_active bool, timestamps)`. Index on `(user_id, type)`.

## 5. Supabase Tables
- `financial_accounts` (primary)
- `banks` (FK by `bank_id`)
- `transactions` (backref for MTD count)

## 6. Relationships
```
banks ──< financial_accounts ──< transactions
                             ──< statements
```

## 7. Edge Functions
- `finance-set-statement-password` — encrypts password via
  `_shared/crypto.ts` (AES-256-GCM, `STATEMENT_ENC_SECRET`).

## 8. Business Logic
No formulas beyond `sum(current_balance where type in savings|checking)`
which lives in `calcNetWorth`.

## 9. AI Logic
None locally. Accounts are input to advisor/chat tools.

## 10. Automation Rules
None. Manual balance updates (Deepak enters after statement).

## 11. Validation Rules
- `name` non-empty, ≤80 chars.
- `type` ∈ {`savings`,`checking`,`brokerage`,`wallet`,`cash`,`other`}.
- `currency` ISO-4217, default `INR`.
- `current_balance` numeric, may be negative for overdraft.

## 12. Error Handling
Delete blocked if account has txns → toast "detach transactions first".

## 13. Notifications
None routine. Balance drift >20% MoM raises `finance_alerts` (future).

## 14. Analytics
`finance.account.created|updated|deleted`.

## 15. Security
RLS: `auth.uid() = user_id` on all writes/reads. Password ciphertext
never returned to client — only edge fn decrypts server-side.

## 16. API Flow
```
Config → supabase.from('financial_accounts').upsert(...)
       → onSuccess → contentStore.bumpFinanceVersion()
```

## 17. State Management
`contentStore.financeVersion` bumped on mutation.

## 18. Performance
Small table (<50 rows expected). No pagination needed.

## 19. Mobile Behavior
Stacked cards, actions in a bottom sheet.

## 20. Desktop Behavior
Grid of tiles, hover reveals actions.

## 21. Future Enhancements
- Live-sync via Plaid-like aggregator (out of scope; India has no
  clean equivalent).
- Balance history table for real net-worth trend.

## 22. Acceptance Criteria + Test Cases
- **AC-1** Create/edit/delete round-trips in one page.
- **AC-2** Deleting an account with txns is blocked with a clear toast.
- **AC-3** Statement password never appears in any client payload
  (network tab audit).
- Tests: none pure-lib; covered by e2e smoke.
