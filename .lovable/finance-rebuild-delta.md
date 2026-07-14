# Finance Rebuild — Delta Report (2026-07-13)

Records every destructive or structural change made during the "go all" pass.

## Migrations

- `20260713110000` (autogen id): added `transactions.detected_kind` (check-constrained enum) + partial index; `subscriptions.auto_detected boolean default false`; `financial_goals.funding_source_account_id`/`retirement_target`/`emergency_target_months`; created `public.detection_runs` with owner-scoped RLS + updated_at trigger.
- `tax_entries` was already present with `fiscal_year`/`regime`/`notes` — kept as-is; TaxCenter should consume those column names (no rename).

## Edge functions (new)

- `finance-detect` — regex classifier for `detected_kind`, merchant normalization, duplicate flagger (±3d, same normalized merchant + amount), suspicious-amount flagger (>5× 60d median), auto-creates monthly subscription when ≥3 same-amount charges/90d. Writes `detection_runs`. `verify_jwt=true`, sliding-window 6/min, `sanitizedErrorResponse`.
- `finance-reconcile` — matches expected sub/loan charges against transactions within ±2d and ±₹1. Emits `missing_charge` / `amount_mismatch` rows into `finance_alerts`. Idempotent per (entity, expected_date, status=open). `verify_jwt=true`, 6/min.
- `jarvis-finance-insight` — on-demand AI explainer. Zod-validated body; context wrapped in `<untrusted_data>`; Lovable AI Gateway (`openai/gpt-5.5`); 10/min.

Added `[functions.finance-detect]`, `[functions.finance-reconcile]`, `[functions.jarvis-finance-insight]` blocks to `supabase/config.toml` (all `verify_jwt = true`).

## Client wiring

- `src/lib/db.ts` `finance` namespace: added `detect()`, `reconcile()`, `insight(topic, context, question?)` helpers routing through `callEdgeFunction`.
- `src/routes/finance/CommandCenter.tsx` replaced the 8-line Overview wrapper with a real page: **Market strip** (reads `market_quotes`, refresh button hits `finance-market-sync`), **Quick actions rail** (Rescan email / Detect & classify / Reconcile / Refresh market — all wired to edge fns with toasts + snapshot invalidation), and the rich existing Overview composed below. No routes changed; `/finance` remains the entry point.

## Explicitly NOT done in this pass (still open)

- **Folder refactor** — plan called for `finance/{banking,investments,spending,planning,intelligence}/` folders. Current tree is flat; the 7-tab IA in `Finance.tsx` matches functionally. Not moved to avoid churning every import and every legacy route redirect.
- **`pg_cron` schedules** — 15m market-sync, 06:00 IST morning-brief, hourly detect/reconcile. Requires the project-specific function URL + anon key; a raw SQL insert (not a migration) is the right vehicle. Run manually from the SQL Editor per the `schedule-jobs-supabase-edge-functions` guide.
- **NSE-unofficial FII/DII fallback** and **market news RSS** — tables exist (`fii_dii_activity`, `market_news`) but the sync function only pulls Yahoo indices/FX/commodities today.
- **Groww PDF import path** — CSV path shipped; PDF path deferred.
- **Retirement projector with SWP** and **Emergency Fund gauge** — schema columns landed (`retirement_target`, `emergency_target_months`), UI not yet built. `financial_goals.funding_source_account_id` also unused in UI.
- **Investments benchmark vs Nifty50, risk score, diversification chart** — deferred.
- **Perf pass** (code-splitting, prefetch-on-hover, virtualization of Txns/Holdings) — deferred.
- **Duplicate/fraud badges** on Txns/Subs list rows — columns populated by `finance-detect`, but list UI does not yet render them.
- **`tax_entries` UI** in TaxCenter — table exists, page still computes from `taxCalc.ts` only.

## Pre-existing linter warnings (surfaced during this pass, not introduced)

- `0014_extension_in_public` — an extension is installed in `public` schema.
- Leaked-password protection is disabled in Supabase Auth. Toggle at Supabase → Auth → Providers → Password.

Both are user-side dashboard actions.