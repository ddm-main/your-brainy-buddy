# Finance — Gap Audit (2026-07-12)

Audit of what the roadmap phases 1–6 ask for vs. what already ships in
`src/routes/finance/*`, `src/routes/config/finance/*`, `src/lib/*`, and
`supabase/functions/finance-*`.

Status: **✅ done** · **🟡 partial** · **❌ missing**

## Phase 1 — Foundation

| Module | Status | Evidence / Gap |
|---|---|---|
| Finance Overview | ✅ | `routes/finance/Overview.tsx` — KPI tiles, net worth, health score, utilization, alerts, category spend, upcoming bills, 6mo trend, insights, goal projections. |
| Accounts | ✅ | `routes/finance/Accounts.tsx` + `config/AccountsConfig.tsx` — CRUD, statement-password encryption via edge fn. |
| Credit Cards | ✅ | `routes/finance/Cards.tsx`, `CardDetail.tsx` — utilization ring, latest statement, statement history, recent txns. |
| Loans | ✅ | `routes/finance/Loans.tsx`, `LoanDetail.tsx` — amortization, EMI drift, EMI-hit tagging, payoff progress. |
| Goals | ✅ | `routes/finance/Goals.tsx` — progress bar, edit, contribution log. |
| Subscriptions | ✅ | `routes/finance/Subs.tsx` — CRUD, auto-detected recurring queue via `recurringDetector.ts`. |
| Transactions | ✅ | `routes/finance/Txns.tsx` — filters (date/type/source/account/reconciled), inline edit, dedup, statement link, recon trigger, running totals. |
| Statements | ✅ | `routes/finance/Statements.tsx` — upload, retry w/ password, drill-in txns, AI summary, validation vs. total_due. |
| Bulk actions on txns | 🟡 | No bulk categorize / bulk delete / bulk mark reconciled. |
| CSV export | ❌ | No export from any Finance route. |

## Phase 2 — Intelligence Layer

| Module | Status | Evidence / Gap |
|---|---|---|
| Auto Statement Parser | ✅ | `finance-extract` + `_shared/statement-pdf.ts` + `_shared/finance-parsers.ts`. |
| Categorization Engine | 🟡 | Category is set by the parser at extract time; **no `category_rules` table**, no learn-from-correction loop. User edits to `transactions.category` don't create a reusable rule. |
| Merchant Recognition | 🟡 | `normalizeMerchant()` in `recurringDetector.ts` only. **No `merchant_aliases` table**, no canonical name resolution across txns. |
| Finance AI Assistant | 🟡 | "get AI take" on Overview uses generic `jarvisChat`. **No dedicated finance-chat edge fn**, no tool calls, no brain routing. |
| Financial Health Score | ✅ | `financeMetrics.ts::calcHealthScore` — savings rate, utilization, payment reliability, debt/assets. |
| Budget Engine | ❌ | No `budgets` table, no per-category limits, no 80/100% alerts. |
| Cash Flow Engine | ✅ | 6mo trend in `useFinanceSnapshot`. |
| Net Worth Engine | ✅ | `calcNetWorth` — assets + card debt + loan debt + tracked savings. |

## Phase 3 — Automation

| Module | Status | Evidence / Gap |
|---|---|---|
| Statement Reconciliation | ✅ | `lib/reconciliation.ts` client-side, triggered from Overview and Txns. |
| Subscription Detection | ✅ | `recurringDetector.ts` — cadence + stable amount + coverage filter. |
| EMI Detection | ✅ | `LoanDetail.tsx` — ±1% match against `emi_amount`/computed EMI. |
| Salary Detection | ❌ | No detector for large recurring credits on ~same day monthly. |
| Investment Detection | ❌ | No SIP/MF debit detector. |
| Duplicate Detection | 🟡 | Only at manual insert time (`findPossibleDuplicate`). No cross-source (email vs. statement) sweep. |
| Fraud / Anomaly Detection | ❌ | Only a static ₹50k "large" flag in the Txns table. No stddev / foreign / odd-hour detectors. |
| Smart Alerts | 🟡 | `finance_alerts` table + Overview surface exist, but only for reconciliation. No hook for detector-fired alerts. |
| Nightly automation | ❌ | Everything runs on user click. No scheduled edge fn. |

## Phase 4 — Analytics

| Module | Status | Evidence / Gap |
|---|---|---|
| Spending Analytics | 🟡 | Overview shows top-6 category list + 6mo trend text-chart. **No `/finance/analytics` route**, no recharts. |
| Income Analytics | 🟡 | Trend has income line; no breakdown by source. |
| Category Analytics | 🟡 | List only. No pie / stacked bar / MoM comparison. |
| Merchant Analytics | ❌ | No top-merchants view. |
| Credit Utilization Analytics | 🟡 | Per-card % on Overview + CardDetail. No historical utilization trend. |
| Goal Analytics | 🟡 | Projections exist. No contribution history chart. |
| Investment Analytics | ❌ | No investments module. |
| Loan Analytics | 🟡 | Amortization + payment history. No interest-paid-to-date, no payoff-simulator. |

## Phase 5 — AI

| Module | Status | Evidence / Gap |
|---|---|---|
| AI Financial Advisor | 🟡 | One-shot "AI take" on Overview. No conversational, no tools. |
| AI Daily Brief | 🟡 | `lib/briefing.ts` exists (JARVIS-wide). No finance-specific section. |
| AI Monthly Report | ❌ | Nothing scheduled. |
| AI Recommendations | ❌ | No recommendation engine. |
| AI Forecasting | ❌ | No forecast (cash runway / month-end projection). |
| AI Budget Suggestions | ❌ | Depends on missing Budget Engine. |
| AI Tax Insights | ❌ | Not started. |
| AI Chat with Finance | ❌ | No dedicated `finance-chat` edge fn. |
| **Multi-brain routing** | ❌ | `brainStore.ts` exists (per prior request) but no Finance AI surface reads it. All calls hit default Gemini via `jarvisChat`. |

## Phase 6 — Security

| Item | Status | Evidence / Gap |
|---|---|---|
| Supabase schema + RLS | ✅ | Every finance table has RLS scoped to `auth.uid()`. |
| Statement PDF storage | ✅ | Private `statement-pdfs` bucket, server-issued signed URLs. |
| Statement password encryption | ✅ | AES-256-GCM via `STATEMENT_ENC_SECRET`, plaintext never in client or DB. |
| Edge functions JWT verify | ✅ | All `finance-*` fns have `verify_jwt = true` in `config.toml`. |
| Input validation | 🟡 | Present in some fns; not audited end-to-end for Zod coverage. |
| Rate limiting | 🟡 | `_shared/rate-limit.ts` exists; not consistently applied to every fn. |
| Security memory doc | ❌ | No `Projects/finance/security-checklist.md`. |
| Finance test coverage | 🟡 | Only `tests/escapePgrst.test.ts` + `tests/safeFetch.test.ts`. No tests for `financeMetrics`, `reconciliation`, `recurringDetector`, `loanCalc`. |

---

## Priority build order

Given phases 1–4/5 all matter (per your answers), the highest-leverage
missing pieces, in order:

1. **Category rules + learning engine** (`category_rules` table, `lib/categorize.ts`, wired into Txns inline edit) — unlocks Budget Engine, Analytics, and every downstream AI insight.
2. **Budget Engine** (`budgets` table, Overview widget, 80/100% alerts).
3. **Multi-brain router for Finance AI** (`_shared/brain-router.ts`, honored by `finance-summarize-statement` first, then new fns).
4. **`finance-chat` edge fn** with tools (`queryTransactions`, `getBudgetStatus`, `getHealthScore`, `forecastCashflow`) + Overview panel.
5. **Detectors bundle** (`lib/detectors/{salary,investment,duplicate,anomaly}.ts`) + wire into Subs-style suggestions queue + alerts.
6. **`/finance/analytics` route** with recharts (spend by category pie, MoM bar, top merchants, utilization trend, income sources).
7. **Nightly `finance-detect` cron edge fn** to run detectors + reconciliation server-side.
8. **CSV export + bulk actions** on Txns (small, ship with #1).
9. **Finance security checklist doc** + unit tests for pure libs.
10. **AI monthly report** (`finance-monthly-report` cron on the 1st).

Deferred: tax insights, investment analytics (need brokerage data source).
