# JARVIS — Full Audit, Rebuild & Production Hardening

Execution model: **one approval per phase**. Within an approved phase I proceed autonomously on destructive fixes (deleting dead routes/files, tightening RLS, rotating exposed secrets, dropping unused tables, replacing placeholder UI) and record every destructive action in that phase's delta report. To start a phase, reply `go phase N` (or with edits).

---

## Phase 0 — Full Audit (report only, zero code changes)

Read every route, component, store, edge function, migration, RLS policy, storage bucket, and shared lib. Produce **`.lovable/audit-2026-07.md`** grouped by module.

Each finding: `severity (P0/P1/P2) — description — evidence (file:line) — recommended fix`.

Sections:
- Frontend (routes, components, stores, hooks)
- Backend (edge functions, shared libs)
- DB schema (tables, columns, indexes, triggers, functions)
- RLS + GRANTs (per table)
- Storage policies (`jarvis-vision`, `statement-pdfs`)
- Auth flows (Google, Azure, Gmail OAuth start/callback, session, reset)
- UX / Nav / Responsiveness / A11y
- Perf (bundle, N+1, cache, long lists)
- State (Zustand stores, React Query keys)
- Animations
- Security (secrets, RLS gaps, XSS/CSRF/IDOR, uploads, headers, prompt injection)
- AI integration (Lovable AI gateway usage, rate limits, quota)
- **Info-leak surfaces** — every place the UI renders raw errors, Supabase URLs, project IDs, storage paths, edge fn URLs, tokens, internal UUIDs

Plus categorized rollup lists: **Bugs / Missing Features / UI Problems / Perf / Security / DB / UX / Code / Refactors**.

Deliverable: the audit file + a Phase 1 kickoff summary. No code changes.

---

## Phase 1 — Security & Production Readiness (blocks all feature work)

- **Secrets sweep** — repo scan for hardcoded keys, verify `.env`/`.env.example`/`.gitignore`, confirm `service_role` never reaches client, rotate anything exposed. Confirm `STATEMENT_ENC_SECRET` is edge-only (never `VITE_`).
- **RLS + GRANTs** on every public table (esp. `user_roles`, `statements`, `transactions`, `emails`, `email_accounts`, `credit_cards`, `loans`, `financial_accounts`). Owner-scoped policies, missing GRANTs added, `has_role`/admin usage verified.
- **Edge functions** — `requireUserId` on every one, zod input validation, CORS allow-list, rate-limits on `jarvis-*`/`gmail-*`/`finance-*`, sanitized error responses (no stack traces, no SQL, no URLs), PII stripped from logs, correct `verify_jwt` per fn.
- **Frontend info-leak fix** (the Gmail-reconnect complaint) — replace every raw error surface with user-friendly copy. Never render Supabase URL, project ID, storage paths, edge fn URLs, tokens, or internal IDs. Centralize in one `toUserError()` helper.
- **XSS/CSRF/IDOR sweep** — `dangerouslySetInnerHTML` (Gmail HTML sanitized), no state-changing GETs, every `?id=` read authorized.
- **File uploads** (`statement-pdfs`, `jarvis-vision`) — MIME + size checks, path-traversal guard, signed-URL scoping, PDF shape validation before parse.
- **Security headers** — CSP, X-Frame-Options, Referrer-Policy in `index.html` + vite dev.
- **Account deletion** — cascade user data + revoke Google/Azure tokens.
- **Prompt-injection guard** on JARVIS chat + AI statement summaries.

Deliverable: green security linter, updated `@security-memory`, delta report of rotated secrets / removed code / tightened policies.

---

## Phase 2 — Finance (largest phase, 2–3 sub-turns under one approval)

Finance becomes the intelligent core; everything auto-syncs.

- **2a Statements & parsing** — redesign page (parse status, validation, matches, period, password, AI summary); fix statement-password saving; better PDF extraction (merchant, category, mode, account, card, ref, UPI); retry/repair flow; statements read-only after parse.
- **2b Transactions & reconciliation** — manual entry, auto-reconcile with statements, detect missing / duplicate / suspicious, `reconciliation_matches` UI.
- **2c Accounts / Cards / Loans / Subs / Goals** — clicking a card opens its detail page (view/edit/delete/history/analytics/linked-data). Kill all "Manage" pages. Loans redesigned with amortization, EMI auto-detect, prepayments, foreclosure, interest-saved. Cards: limit / outstanding / available / utilisation / rewards / payment history / paid-from account. Subs: auto-detect recurring, renewals, duplicates, price hikes, unused. Goals: milestones, sources, AI recs.
- **2d Overview + interconnection** — Net worth, cash flow, income/expenses, health score, upcoming bills, AI insights. Wire the chain **Statement → Transactions → Merchant → Category → Card/Loan/Sub → Goal → HUD → Notifications → AI summary** so no module is isolated.

Deliverable: end-to-end demo — upload statement → transactions land → card + subs update → alerts on HUD.

---

## Phase 3 — HUD, Tasks, Notes, Projects

- **HUD** — real data in Mission Control (today's tasks, meetings, due bills, cards, EMIs, goals, AI suggestions, finance alerts). AI Daily Brief. Signal becomes notification center. Pulse shows net worth / cash flow / income / expenses / savings / investments / credit util / loan status / health score. JARVIS core = command center (palette + voice).
- **Tasks** — priorities, subtasks, recurring, reminders; Kanban + calendar + timeline; attachments; project/finance links; AI suggestions.
- **Notes** — markdown + rich text, images, voice, tags, search, backlinks, AI summaries, cross-links.
- **Projects** — dashboard + Kanban + timeline + files + tasks + notes + budget + milestones + progress; budget linked to Finance.

Deliverable: cross-module links visible in every surface.

---

## Phase 4 — JARVIS AI + Knowledge Hub (replaces Link)

- JARVIS voice + chat with persistent `jarvis_memory`, route-aware context, global search across Notes/Tasks/Projects/Finance, tool-calling (create task, add transaction, summarize statement, plan day), smart suggestions, document analysis, planning.
- Replace Link module with **Knowledge Hub** — bookmarks, docs, quick links, AI search over saved items + Notes.
- Consolidated AI settings + model picker in Config.

Deliverable: chat can answer "what did I spend on subs last month?" and create a follow-up task from the answer.

---

## Phase 5 — Notifications + Config polish

- **Notification center** — bills, EMIs, card dues, statement events, task/project due, goals, AI insights, security alerts. Persistence, read state, in-app + optional email.
- **Config** — remove the "Config" text from top-bar button (icon only), regroup subsections as **Appearance, AI, Finance, Notifications, Security, Automation, Backup, Import/Export, Developer**. Existing entity forms (Email, Banks, Accounts, Cards, Loans, Goals, Subs, Projects) slot under Finance / Automation.

Deliverable: notification bell with live badge and grouped Config.

---

## Phase 6 — QA, Perf, A11y, Final Security Re-scan

- **Perf** — route-level code split, React Query cache audit, kill N+1s in Finance, virtualize long lists.
- **A11y** — keyboard nav everywhere, focus rings, ARIA on custom controls, contrast on cyan theme.
- **Responsive** sweep across mobile/tablet.
- Re-run security scanner, fix regressions, smoke-test every route signed-in.
- Update `plan.md`, `Dashboard.md`, README; add `PRODUCTION-CHECKLIST.md`.

Deliverable: production-ready build + final combined report.

---

## Technical notes

- Stack unchanged: Vite + React + TS + Tailwind, Supabase, HUD theme (cyan + system font).
- Any new/changed tables + RLS go through `supabase--migration`, at most one migration per phase.
- Edge functions redeploy automatically; secrets via `add_secret`.
- Every destructive change (deletions, RLS tightening, secret rotation, dropped tables/routes, placeholder removal) is listed in that phase's delta report.
- One approval gate per phase.

---

**On approval I start Phase 0 — Audit.** Reply `go phase 0` to begin.
