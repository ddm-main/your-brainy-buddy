# Strip the app down to Market only — remaining cleanup

Most of this strip-down is already done. Verified against the live project:

- Frontend is already Market-only: `src/routes/` has just `Auth`, `Config`, `Market`, `NotFound`, `ResetPassword` plus `config/` and `market/`. No finance/projects/tasks/inbox routes, no `components/core`, no JARVIS/voice/content stores, and the command palette only lists Market/Config commands.
- Edge functions are already Market-only: no `finance-*`, `gmail-*` or `jarvis-*` functions remain. `shoonya-oauth-callback` **is** still used by Market (broker connect flow), so it stays.
- The database is already stripped: every finance / email / projects / tasks / inbox / JARVIS table listed in the original plan is gone, the `app_section` enum is already just `market, config`, no stale `user_page_access` rows exist, and no view or cron job references a removed table or a deleted function.

What is left is residue, in three small pieces.

## 1. Orphaned database function

`public.increment_jarvis_usage(uuid, integer, bigint, text)` still exists but writes to the dropped `jarvis_usage_daily` table, so any call errors. It gets dropped in one migration. (`purge_old_jarvis_interactions` is already gone.)

## 2. Dead tests and fixtures

These import edge-function modules that no longer exist (`_shared/statement-parsers`, `_shared/statement-skeleton`, `_shared/subject-period`, `_shared/card-payment-status`), so the test suite cannot run clean:

- `tests/statementParsers.test.ts`
- `tests/statementSkeleton.test.ts`
- `tests/fixtures/statements/` (all fixtures, including `raw/`)

They are deleted. Every other test file is market-related and stays.

## 3. Stale JARVIS-era docs and workspace files

The repo root still carries the personal-OS scaffolding that no longer matches a market-only app: `Projects/finance/`, `Projects/jarvis/`, `Areas/`, `Inbox/`, `Archive/`, `Resources/_about.md`, `System/Memory/`, `System/Logs/`, `System/Protocols/`, `System/Backend/`, `Dashboard.md`, and the `.claude/` agents.

Because these are your notes rather than app code, nothing here is deleted without your say-so — flag which you want kept and the rest is moved to `Archive/` (never deleted). Default if you don't care: leave them exactly as they are; they don't ship in the build.

## Verification

- Migration applied and `increment_jarvis_usage` no longer listed.
- `bunx vitest run` passes with no missing-module failures.
- Typecheck clean; `/market` loads, every market sub-tab renders, `/config` shows only Market Config + Admin, no console or network errors.
