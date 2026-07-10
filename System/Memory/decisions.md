# Decisions

Significant decisions, dated, with the *why*. Prevents re-litigating old choices.

- **2026-07-07** — Built JARVIS as a file-based agentic OS on Claude Code (PARA folders + memory + skills + agents). Why: files are durable, portable, and every session compounds.
- **2026-07-09** — JARVIS Supabase posture is single-user: every JARVIS table has RLS `USING (true) WITH CHECK (true)` for anon + authenticated. Why: only Deepak uses the HUD; no login flow. If multi-tenant is ever needed, add `user_id` columns and swap policies to `auth.uid() = user_id` — do not just tighten in place.
