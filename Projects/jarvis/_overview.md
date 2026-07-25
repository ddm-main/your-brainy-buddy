# Project: JARVIS

**Outcome:** A personal AI operating system for Deepak — one place to see focus, inbox, finance, projects, memory, and act on them via chat/voice/commands. Reuses the existing cyan neural-brain HUD shell.
**Deadline:** none (phased)
**Status:** active · started 2026-07-09

## Approach
Three sequential approval gates:
1. **PRD pack** (this) — blueprint captured as living docs under `Projects/jarvis/`.
2. **Supabase schema** — v1 tables with GRANTs + RLS in one migration.
3. **Phase 1 MVP build** — wire existing HUD (JarvisCore, HudPanel, VoiceBar, CommandPalette) to the schema: Tasks, Notes, Inbox basic, Finance structure, Projects, command bar.

## Next actions
- [ ] Deepak: rotate the previously-leaked Supabase anon key, set `CRON_SECRET` in Supabase secrets
- [ ] Deepak: obtain a working `SUPABASE_ACCESS_TOKEN` — every migration/edge-function change since 2026-07-10 is code-complete but undeployed, blocking all live verification
- [ ] Once unblocked: apply all pending migrations, deploy all changed edge functions, re-run `get_advisors`
- [ ] Pick Round 4 focus (see `roadmap.md` — HUD/Notifications wiring, further Finance depth, or a Tasks/Notes/Projects/Link module rebuild are all still open)

## Log
- 2026-07-24 — Repaired Market Screener parity: NSE-equity default universe, same-session price/return/volume predicates, arithmetic prior-30-session volume baseline, raw-share units, global sorting, auditable filter columns, and deployed the corrected EOD producer.
- 2026-07-09 — project created; PRD pack written (PRD, architecture, data-model, roadmap, homepage-spec)
- 2026-07-09 — Step 2 executed: Phase 1 Supabase schema live (tasks, notes, decisions, projects, emails, finance tables, jarvis_actions; single-user RLS)
- 2026-07-10 — Production security hardening round: owner-scoped RLS rewrite on every table (from single-user-open to `auth.uid()=user_id`), fixed a hardcoded-fallback OAuth-state signing secret, fixed a CRON_SECRET bypass, scrubbed leaked real credentials from `.env.example`
- 2026-07-10/11 — Full-app UI overhaul: every Finance card became click-to-expand-edit-in-place (replacing separate Manage pages), bank-statement PDF parsing + password handling, a real Decisions screen, working notification bell/Link-status/AI-status chips
- 2026-07-11 — Finance Intelligence Layer: net worth, credit utilization, a 4-component financial health score with AI commentary, loan amortization + payment history, client-side subscription/loan-vs-transaction reconciliation with a `finance_alerts` review queue
- 2026-07-12 — Round 3, security & correctness hardening: closed the Gmail-OAuth-flow leak of internal Supabase/Postgres error detail (Deepak's specific complaint) and the same raw-error-to-client pattern across ~15 other edge functions; added rate limiting to the 4 previously-unprotected AI endpoints (tts/transcribe/vision/vision-upload); fixed a bug where JARVIS chat's create_task/create_note silently duplicated every voice/chat-created row. Full findings in `audit-2026-07.md`.
