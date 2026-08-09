# Strip the app down to Market only

Everything that is not Market (or the config needed to run Market) gets removed: Finance, Projects, Tasks, Inbox, Email/Gmail sync, the Home/HUD dashboard and the JARVIS assistant. Their code, edge functions and database tables go away permanently.

## What remains after this

- `/market/*` — the full market section, unchanged
- `/config` — Market Config + Admin only
- `/auth`, `/reset-password` — sign in / password reset
- `/` redirects to `/market`; the top bar keeps only Market, Config and account controls

## Frontend removals

- Routes: `Home.tsx`, `Finance.tsx`, `Projects.tsx`, `Tasks.tsx`, `Inbox.tsx` and the whole `src/routes/finance/` folder
- Config tabs: Accounts, Cards, Loans, Goals, Subscriptions, Finance, Email, Projects (plus `config/email/` and `config/finance/` folders); Market Config and Admin stay
- Components: `src/components/finance/`, `src/components/core/` (JARVIS core, conversation, brain picker), HUD pieces tied to the assistant (`VoiceBar`, `ContentPanel`, ambient/boot chrome only used by Home) — shared HUD primitives used by Market (`HudPanel`, `HudModal`, `DataTable`, `HudChart`, `HudSelect`, `HudDatePicker`, `KineticNumber`, `ToastLayer`, `FeedStatusChip`, `QuotaStatusChip`, `TopBar`, `ErrorBoundary`) are kept
- Libs: `briefing`, `financeMetrics`, `useFinanceSnapshot`, `gmail`, `growwImport`, `investmentCalc`, `loanCalc`, `taxCalc`, `reconciliation`, `recurringDetector`, `subscriptionAudit`, `reminders`, `jarvisChat`, `jarvisTools`, `tts`, `stt`, `vision`, `screenShare`, `weather`, `data/indianBanks.ts`
- Stores: `brainStore`, `voiceStore`, `contentStore`, `aiStatusStore` (and the reminder/JARVIS wiring in `App.tsx`)
- Command palette: drop non-market commands

## Edge function removals

All `finance-*`, `gmail-*`, `jarvis-*` functions plus `shoonya-oauth-callback` if unused by Market. They are deleted from the repo and from the deployed Supabase project. Every `market-*` function and `admin-users` is untouched.

## Database removals (permanent)

Dropped in dependency order in a single migration:

- Finance: `transactions`, `statements`, `statement_skeletons`, `financial_accounts`, `financial_goals`, `credit_cards`, `loans`, `banks`, `budgets`, `subscriptions`, `insurance_policies`, `holdings`, `holding_transactions`, `nav_history`, `tax_entries`, `finance_alerts`, `finance_reports`, `finance_suggestions`, `finance_email_rules`, `category_rules`, `merchant_aliases`, `reconciliation_matches`, `detection_runs`, `corporate_actions`
- Email: `emails`, `email_accounts`, `email_actions`, `email_attachments`, `gmail_sync_runs`
- Projects/Tasks/Inbox/notes: `projects`, `project_updates`, `next_actions`, `tasks`, `inbox_items`, `notes`, `areas`, `decisions`, `daily_logs`, `morning_briefs`
- JARVIS: `jarvis_actions`, `jarvis_interactions`, `jarvis_memory`, `jarvis_reminders`, `jarvis_usage_daily`, `memories`, `messages`, `threads`, `push_subscriptions`
- Related functions/triggers only these tables used (e.g. `increment_jarvis_usage`, `purge_old_jarvis_interactions`, and the finance parts of `prune_old_data` / `run_daily_maintenance` rewritten to market-only)
- Any pg_cron jobs invoking deleted edge functions are unscheduled
- `app_section` enum trimmed to `market` and `config`, with `user_page_access` rows for removed sections deleted first

All `market_*`, `system_*`, `user_roles`, `user_page_access` tables are kept.

## Technical notes

- Order matters: unschedule cron jobs → delete `user_page_access` rows → drop tables (CASCADE where FKs chain) → drop orphaned functions → recreate the `app_section` enum with only the two remaining values.
- `market_holdings` / `market_positions` / `market_funds` are market-owned and are **not** the finance `holdings` table — they stay.
- After the code deletions, a typecheck pass fixes any leftover imports; `AccessGate` and the access store are reduced to the two remaining sections.

## Verification

Typecheck clean, app loads at `/market`, every market sub-tab renders, Config shows only Market Config + Admin, and no console/network errors from removed endpoints.
