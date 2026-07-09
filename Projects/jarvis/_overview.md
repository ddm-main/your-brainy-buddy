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
- [ ] Approve Step 2 — Supabase schema migration plan
- [ ] Approve Step 3 — Phase 1 MVP build plan
- [ ] Decide which email accounts feed the Inbox module (defer to Step 3)

## Log
- 2026-07-09 — project created; PRD pack written (PRD, architecture, data-model, roadmap, homepage-spec)
