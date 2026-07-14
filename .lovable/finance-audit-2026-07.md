# Finance Module — Audit (Phase F0)

Date: 2026-07-13. Scope: `src/routes/finance/*`, `src/routes/Finance.tsx`, `src/lib/{financeMetrics,loanCalc,reconciliation,recurringDetector,useFinanceSnapshot}.ts`, `supabase/functions/finance-*`, finance-related tables.

Severity: **S1** critical / **S2** high / **S3** medium / **S4** low. IDs are stable so later phases can reference them.

---

## 1. Executive Summary

Finance today is a competent CRUD tracker: 18 route files (~4.6k LOC) across 13 flat tabs collapsed into 5 groups, 8 edge functions, and ~15 tables. It works, but it is not an intelligence product. There is no daily brief, no market data, no forecast, no unified alert feed, no auto-reconciliation trigger, no live NAV/quote surface, no financial health score, no per-user feature flags for asset classes. Detail pages exist for accounts/cards/loans/goals/investments but not for statements or subscriptions. Server-side error paths still leak upstream JSON in a handful of edge fns. Indexes are missing on the two hottest tables (`transactions`, `statements`). No `finance_alerts`, `finance_forecasts`, `market_quotes`, `nav_history`, or `user_feature_flags` tables exist yet. This audit drives phases F1–F11.

---

## 2. Findings by Area

### 2.1 Information Architecture (UI/UX + Navigation)
- **F-IA-1 (S2)** 13 tabs behind 5 groups is still busy; industry apps use 5–7 top sections with a dashboard-first landing. Overview is one of five siblings instead of the default surface.
- **F-IA-2 (S3)** Create/edit forms are half in Config, half inline (Cards, Loans, Goals, Subs still have inline create dialogs). Violates the "Config-only" rule.
- **F-IA-3 (S3)** No detail surfaces for Statements or Subscriptions; users route out to view a row.
- **F-IA-4 (S3)** Investments splits MF/stocks/others in one 414-line file; asset classes cannot be toggled per user.
- **F-IA-5 (S4)** Sub-tab strip re-renders on every route change (inline object literal in `GROUPS`).

### 2.2 Command Center / Overview (`Overview.tsx`, 414 LOC)
- **F-CC-1 (S1)** No Financial Health Score, no forecast, no market snapshot, no alerts feed, no AI insights panel — all listed as required.
- **F-CC-2 (S2)** KPIs computed client-side by looping every txn on every render; no server-side aggregate.
- **F-CC-3 (S2)** Upcoming Bills / EMIs / SIPs / Renewals are duplicated across Cards/Loans/Subs pages, not a single hook.
- **F-CC-4 (S3)** No realtime; page must be reloaded after statement upload.

### 2.3 Banking
- **F-BK-1 (S2)** `credit_cards.outstanding` and `loans.outstanding` are static columns; not recomputed from linked transactions/statements. Drift is guaranteed.
- **F-BK-2 (S2)** `Statements.tsx` (338 LOC) has parse retry but no confidence surface, no bulk reprocess, no validation UI.
- **F-BK-3 (S3)** `LoanDetail.tsx` amortization runs client-side each render; no prepayment simulator or interest-saved projection.
- **F-BK-4 (S3)** Cards list has no autopay / due-date warning aggregation.

### 2.4 Investments
- **F-IV-1 (S1)** No live NAV/quote refresh loop; `finance-sync-nav` exists but is not scheduled and covers only funds already held.
- **F-IV-2 (S1)** No portfolio metrics (XIRR/CAGR/allocation/diversification/risk/benchmark). Only per-holding value shown.
- **F-IV-3 (S2)** Optional asset classes (Gold/FD/PPF/EPF/NPS/Crypto/Bonds/ETF/Real Estate) hardcoded on; should be per-user flags off by default.
- **F-IV-4 (S3)** Groww import path exists (`finance-import-groww`) but is buried under Investments, not the unified import center.

### 2.5 Spending
- **F-SP-1 (S1)** No auto-detection for salary / SIP / EMI / insurance / dividend / interest / refund / internal transfer beyond basic recurring detection.
- **F-SP-2 (S2)** Manual transactions do not auto-reconcile with imported statements (`reconciliation.ts` runs only when user clicks reconcile).
- **F-SP-3 (S2)** No duplicate / fraud / missing-payment detectors surfaced inline.
- **F-SP-4 (S3)** Merchant aliases live in `merchant_aliases` but categorization rules (`category_rules`) are not learned from user edits.
- **F-SP-5 (S3)** `Subs.tsx` renewal alerts are static; no price-hike / unused / failed-payment detection.
- **F-SP-6 (S4)** `Txns.tsx` (293 LOC) is not virtualized; degrades past ~1k rows.

### 2.6 Planning
- **F-PL-1 (S2)** Budget has no forecast overlay; goals have no funding-source linkage.
- **F-PL-2 (S2)** Insurance schema piggybacks on `subscriptions`; no dedicated table with claims/premium schedule.
- **F-PL-3 (S3)** Tax center shows manual entry only; no capital-gains pull from investments.
- **F-PL-4 (S3)** No Emergency Fund or Retirement calculators.

### 2.7 Intelligence
- **F-IN-1 (S1)** No `advisor` chat scoped to finance context, no Morning Brief, no Market Brief, no forecast, no unified alert feed. Entire section absent.
- **F-IN-2 (S1)** No global/Indian market ticker (Nifty/Sensex/Nasdaq/Dow/Gold/USD-INR/BTC/FII-DII/IPO/news). No `market_quotes` table, no aggregator edge fn.
- **F-IN-3 (S2)** `jarvis-chat` is not injected with finance context on `/finance/*` routes.

### 2.8 Reports
- **F-RP-1 (S2)** `Reports.tsx` (95 LOC) lists stored reports only; no daily/weekly/monthly/quarterly/annual/tax generators, no PDF/Excel export, no chart snapshots.
- **F-RP-2 (S3)** No AI summary attached to generated reports.

### 2.9 Data Model
- **F-DB-1 (S2)** Missing indexes on `transactions(user_id, occurred_at desc)`, `statements(user_id, period_end desc)`, `subscriptions(user_id, next_renewal_at)`, `credit_cards(user_id)`, `loans(user_id)`, `financial_goals(user_id)`.
- **F-DB-2 (S2)** No `finance_alerts`, `finance_forecasts`, `market_quotes`, `nav_history`, `user_feature_flags` tables.
- **F-DB-3 (S3)** `statements` lacks `confidence`, `validated_at`, `validated_by`; `transactions` lacks a `source` enum.
- **F-DB-4 (S3)** No triggers recompute derived balances (`credit_cards.outstanding`, `loans.outstanding`, `financial_goals.current`).
- **F-DB-5 (S4)** `updated_at` triggers missing on `daily_logs`, `messages`, `decisions` (out of scope but noted).

### 2.10 RLS / Security
- **F-SC-1 (S1)** Supabase linter still reports `Extension in Public` and `Leaked Password Protection Disabled` (carried over from global audit).
- **F-SC-2 (S1)** `finance-upload-statement` accepts any authed user's PDF with no magic-byte / size / MIME hardening beyond content-type header.
- **F-SC-3 (S2)** `finance-set-statement-password` has no length/complexity guard on plaintext password.
- **F-SC-4 (S2)** Several finance edge fns return raw upstream error bodies; only `jarvis-*` use `sanitizedErrorResponse`. Affected: `finance-extract`, `finance-retry-statement`, `finance-summarize-statement`, `finance-sync-nav`, `finance-import-groww`.
- **F-SC-5 (S2)** No zod validation on request bodies for `finance-retry-statement`, `finance-summarize-statement`, `finance-set-statement-password`.
- **F-SC-6 (S3)** No rate-limit on any finance edge fn.
- **F-SC-7 (S3)** `Statements.tsx` `ErrorPanel` still renders `err.details` (raw JSON from upstream) — info-leak.
- **F-SC-8 (S4)** No CSP hardening / security headers (global concern, tracked in main audit).

### 2.11 Performance
- **F-PF-1 (S2)** Finance routes are not code-split (all imports eager in `Finance.tsx`).
- **F-PF-2 (S2)** `Overview.tsx` fires 8 parallel queries with no shared cache keys — N+1 across sibling pages.
- **F-PF-3 (S3)** `Investments.tsx` recomputes portfolio metrics on every render.
- **F-PF-4 (S3)** No React Query staleTime tuning; every route re-fetches on mount.

### 2.12 A11y / Responsiveness
- **F-AX-1 (S3)** Sub-tab strip is not keyboard-focusable in a predictable order (uses raw NavLink styling, no `role="tablist"`).
- **F-AX-2 (S3)** Detail pages break under 640px — fixed side-by-side grids.
- **F-AX-3 (S4)** Motion not gated by `prefers-reduced-motion` on Overview KPI counters.

### 2.13 Dead / Placeholder
- **F-DP-1 (S3)** `_shared.tsx` exports helpers used by only one component.
- **F-DP-2 (S3)** `TaxCenter.tsx` (81 LOC) is a stub with hardcoded categories.
- **F-DP-3 (S3)** `Insurance.tsx` reads from `subscriptions` with `type='insurance'`; effectively a filter view masquerading as a section.

---

## 3. Industry Benchmark Comparison

| Feature | JARVIS today | Groww | CRED | INDmoney | ET Money | Google Finance | Moneycontrol |
|---|---|---|---|---|---|---|---|
| Dashboard-first landing | Partial | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Financial Health Score | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Net Worth (auto) | Manual | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ |
| Live market strip | ✗ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ |
| MF NAV auto-sync | Partial | ✓ | ✗ | ✓ | ✓ | ✗ | ✓ |
| Stock quotes | ✗ | ✓ | ✗ | ✓ | ✗ | ✓ | ✓ |
| Portfolio XIRR/CAGR | ✗ | ✓ | ✗ | ✓ | ✓ | ✗ | ✓ |
| Auto-categorization | Basic | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Auto-reconcile | Manual | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Recurring detection | Partial | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Duplicate / fraud detect | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Budget forecast | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ |
| Goal funding source | ✗ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ |
| Insurance tracking | Stub | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ |
| Tax / capital gains | Manual | ✓ | ✗ | ✓ | ✓ | ✗ | ✓ |
| Morning brief | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ |
| Market brief | ✗ | ✓ | ✗ | ✓ | ✗ | ✓ | ✓ |
| Personalized AI advisor | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| Report PDF/Excel export | ✗ | ✓ | ✗ | ✓ | ✓ | ✗ | ✓ |

---

## 4. Security Audit (Finance-scoped)

See F-SC-1..F-SC-8 above. Key remediations for F2:
1. zod + rate-limit + `sanitizedErrorResponse` on every finance edge fn.
2. PDF magic-byte + size (≤ 15 MB) + MIME allowlist on `finance-upload-statement`.
3. Password length ≥ 4 on `finance-set-statement-password`, stored via `STATEMENT_ENC_SECRET`.
4. Replace `ErrorPanel` raw JSON dump with friendly message map.
5. Enable leaked-password protection and move `pg_net`/`pg_cron` out of `public`.

---

## 5. UI/UX Improvement Report

1. Collapse to 7 sections (Command / Banking / Investments / Spending / Planning / Intelligence / Reports).
2. Command Center becomes the default `/finance` route.
3. Card grid + slide-in detail drawer replaces per-row route navigation.
4. Live KPI counters, animated only when `prefers-reduced-motion: no-preference`.
5. Every list virtualized past 100 rows (`@tanstack/react-virtual`).
6. Empty / loading / error states standardized via one `<Panel state=... />` primitive.
7. Sub-tab strip becomes a proper `role="tablist"` with arrow-key nav.

---

## 6. Architecture Improvement Plan

- One aggregator hook per section (`useCommandCenter`, `useBanking`, `useSpending` …) — no page-level parallel query fans.
- Server-side derived tables (`finance_forecasts`, `finance_alerts`, `finance_reports`) written by scheduled edge fns; client only reads.
- Realtime subscriptions on `transactions`, `statements`, `market_quotes`, `finance_alerts` for instant UI refresh.
- Feature-flag gate (`user_feature_flags`) toggles optional asset classes without code branches.
- All AI calls through `jarvis-chat` / new `finance-advisor` edge fn using Lovable AI Gateway; no client-side LLM keys.

---

## 7. Destructive Change Delta (proposed for later phases)

| Phase | Change | Reversible? |
|---|---|---|
| F1 | Redirect `/finance/{accounts,cards,loans,goals,subs,txns,statements,investments,budget,goals,insurance,tax}` under new sections | Yes (routes stay valid via redirects) |
| F2 | Drop `outstanding` from `credit_cards` / `loans` in favor of trigger-computed view | No — data migration in same migration |
| F2 | Add `source` enum to `transactions`; backfill existing rows to `imported` | Yes |
| F2 | Move extensions out of `public` schema | Yes |
| F5 | Hide non-MF/stock asset classes behind `user_feature_flags` (default off) | Yes (toggle in Config) |
| F7 | Split `insurance` out of `subscriptions` into own table; backfill | Yes |
| F10 | Remove standalone Finance settings surfaces once mirrored into Config | Yes |

---

## 8. Next

Phase F1 (Information Architecture) — collapse routes, add redirects, land the new `/finance/command` default. No DB changes.