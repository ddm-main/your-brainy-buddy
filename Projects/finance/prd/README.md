# Finance PRD

Personal-finance module set for JARVIS OS. Single user (Deepak). Every
module below owns a spec file that follows `_template.md` (22 sections,
Purpose → Test Cases). Each spec links back to
`Projects/finance/gap-audit.md` for build status.

## Status legend
- ✅ shipped and load-bearing
- 🟡 partial — usable, gap listed
- ❌ not built

## Phase index

### Phase 1 — Foundation
| # | Module | Status | Spec |
|--:|---|---|---|
| 01 | Overview Dashboard        | ✅ | [spec](phase-1-foundation/01-overview-dashboard.md) |
| 02 | Accounts                  | ✅ | [spec](phase-1-foundation/02-accounts.md) |
| 03 | Credit Cards              | ✅ | [spec](phase-1-foundation/03-credit-cards.md) |
| 04 | Loans                     | ✅ | [spec](phase-1-foundation/04-loans.md) |
| 05 | Goals                     | ✅ | [spec](phase-1-foundation/05-goals.md) |
| 06 | Subscriptions             | ✅ | [spec](phase-1-foundation/06-subscriptions.md) |
| 07 | Transactions              | 🟡 | [spec](phase-1-foundation/07-transactions.md) |
| 08 | Statements                | ✅ | [spec](phase-1-foundation/08-statements.md) |

### Phase 2 — Intelligence
| # | Module | Status | Spec |
|--:|---|---|---|
| 09 | Auto Statement Parser     | ✅ | [spec](phase-2-intelligence/09-statement-parser.md) |
| 10 | Categorization Engine     | 🟡 | [spec](phase-2-intelligence/10-categorization-engine.md) |
| 11 | Merchant Recognition      | 🟡 | [spec](phase-2-intelligence/11-merchant-recognition.md) |
| 12 | Finance AI Assistant      | 🟡 | [spec](phase-2-intelligence/12-finance-ai-assistant.md) |
| 13 | Financial Health Score    | ✅ | [spec](phase-2-intelligence/13-financial-health-score.md) |
| 14 | Budget Engine             | 🟡 | [spec](phase-2-intelligence/14-budget-engine.md) |
| 15 | Cash Flow Engine          | ✅ | [spec](phase-2-intelligence/15-cash-flow-engine.md) |
| 16 | Net Worth Engine          | ✅ | [spec](phase-2-intelligence/16-net-worth-engine.md) |

### Phase 3 — Automation
| # | Module | Status | Spec |
|--:|---|---|---|
| 17 | Reconciliation            | ✅ | [spec](phase-3-automation/17-reconciliation.md) |
| 18 | Subscription Detection    | ✅ | [spec](phase-3-automation/18-subscription-detection.md) |
| 19 | EMI Detection             | ✅ | [spec](phase-3-automation/19-emi-detection.md) |
| 20 | Salary Detection          | 🟡 | [spec](phase-3-automation/20-salary-detection.md) |
| 21 | Investment Detection      | 🟡 | [spec](phase-3-automation/21-investment-detection.md) |
| 22 | Duplicate Detection       | 🟡 | [spec](phase-3-automation/22-duplicate-detection.md) |
| 23 | Fraud / Anomaly Detection | 🟡 | [spec](phase-3-automation/23-fraud-detection.md) |
| 24 | Smart Alerts              | 🟡 | [spec](phase-3-automation/24-smart-alerts.md) |

### Phase 4 — Analytics
| # | Module | Status | Spec |
|--:|---|---|---|
| 25 | Spending Analytics        | ✅ | [spec](phase-4-analytics/25-spending.md) |
| 26 | Income Analytics          | 🟡 | [spec](phase-4-analytics/26-income.md) |
| 27 | Category Analytics        | ✅ | [spec](phase-4-analytics/27-category.md) |
| 28 | Merchant Analytics        | 🟡 | [spec](phase-4-analytics/28-merchant.md) |
| 29 | Credit Utilization        | 🟡 | [spec](phase-4-analytics/29-credit-utilization.md) |
| 30 | Goal Analytics            | 🟡 | [spec](phase-4-analytics/30-goal.md) |
| 31 | Investment Analytics      | ❌ | [spec](phase-4-analytics/31-investment.md) |
| 32 | Loan Analytics            | 🟡 | [spec](phase-4-analytics/32-loan.md) |

### Phase 5 — AI
| # | Module | Status | Spec |
|--:|---|---|---|
| 33 | AI Financial Advisor      | 🟡 | [spec](phase-5-ai/33-advisor.md) |
| 34 | AI Daily Brief            | 🟡 | [spec](phase-5-ai/34-daily-brief.md) |
| 35 | AI Monthly Report         | ✅ | [spec](phase-5-ai/35-monthly-report.md) |
| 36 | AI Recommendations        | ❌ | [spec](phase-5-ai/36-recommendations.md) |
| 37 | AI Forecasting            | ❌ | [spec](phase-5-ai/37-forecasting.md) |
| 38 | AI Budget Suggestions     | 🟡 | [spec](phase-5-ai/38-budget-suggestions.md) |
| 39 | AI Tax Insights           | ❌ | [spec](phase-5-ai/39-tax-insights.md) |
| 40 | AI Chat with Finance      | 🟡 | [spec](phase-5-ai/40-chat.md) |

### Phase 6 — Security
| # | Module | Status | Spec |
|--:|---|---|---|
| 41 | DB Architecture           | ✅ | [spec](phase-6-security/41-db-architecture.md) |
| 42 | RLS Policies              | ✅ | [spec](phase-6-security/42-rls.md) |
| 43 | Authentication            | ✅ | [spec](phase-6-security/43-auth.md) |
| 44 | Statement Security        | ✅ | [spec](phase-6-security/44-statement-security.md) |
| 45 | Edge Functions            | ✅ | [spec](phase-6-security/45-edge-functions.md) |
| 46 | API Security              | 🟡 | [spec](phase-6-security/46-api-security.md) |
| 47 | Production Security       | 🟡 | [spec](phase-6-security/47-prod-security.md) |
| 48 | Testing                   | 🟡 | [spec](phase-6-security/48-testing.md) |

## Gap → build map
Live gap tracker: `Projects/finance/gap-audit.md`. Active build waves
tracked in `.lovable/plan.md` (Wave D-1 through C-4).
