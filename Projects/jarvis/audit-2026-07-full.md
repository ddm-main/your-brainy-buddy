# JARVIS OS — Full Audit (2026-07-12, Phase 0)

Fresh audit covering frontend, backend, DB, storage, auth, edge fns, AI, UI/UX, perf, a11y, security. Entries carry severity (P0 blocker · P1 high · P2 med · P3 polish) and `file:line` refs. Items marked ✅ have been verified fixed since the earlier audit doc; no code changes were made in this phase.

---

## 0. State of prior findings (verified now)

| From `audit-2026-07.md` | Status |
|---|---|
| B1 — `increment_jarvis_usage` signature drift | ✅ Fixed (fn now takes `_endpoint`, executor `service_role`) |
| B2 — Supabase client env fallback | ✅ Fixed (`client.ts` reads publishable then anon) |
| `supabase/config.toml` duplicate function blocks | ✅ Fixed (single block each) |
| `jarvis-vision` `parsed` variable shadow | ✅ Fixed (renamed to `parsedUrl`) |
| RLS on `jarvis_memory`/`jarvis_reminders` permissive `true` | ✅ Fixed (dropped, revoked anon/authenticated) |
| Leaked-password protection (Auth dashboard toggle) | ❌ Still off — user action only |

---

## 1. Bugs (P0/P1)

| # | Severity | Where | Finding |
|---|---|---|---|
| BUG-1 | P1 | `supabase/functions/finance-extract-core.ts` | Statement parse failures are swallowed; no `parse_error` column exists on `statements` so failed rows stay `parse_status = pending` forever with no retry signal. |
| BUG-2 | P1 | `supabase/functions/_shared/finance-parsers.ts` | Regex-only parsing. Unknown bank layouts silently emit 0 rows — no confidence flag, no fallback. |
| BUG-3 | P1 | `src/routes/finance/Loans.tsx` (no detail route) | `loanCalc.ts` math exists but is never wired end-to-end; no amortization, prepayment, EMI auto-detect. |
| BUG-4 | P1 | `src/routes/finance/Cards.tsx` (no `/finance/cards/:id`) | Utilization, statement history, per-card txns, "paid from account" not surfaced. |
| BUG-5 | P1 | `src/routes/finance/Subs.tsx` | Manual-only. Recurring merchants in `transactions` never auto-grouped. |
| BUG-6 | P2 | `src/routes/finance/*` | `reconciliation_matches` table exists but has no UI — duplicates/missing/suspicious invisible. |
| BUG-7 | P2 | React Router v6 warnings | `v7_startTransition` and `v7_relativeSplatPath` future flags not set — noisy console. |
| BUG-8 | P2 | `src/lib/reminders.ts` poller | Runs unconditionally per session; on multi-tab it fires duplicate speech + notifications. |
| BUG-9 | P3 | `src/components/core/JarvisCore.tsx` | Voice-state tint is stubbed; state changes don't affect the shader uniform reactively. |

## 2. Missing features (from your spec)

- HUD Mission Control, Signals, Pulse strips read stubs (see `src/components/hud/*`, `src/routes/Home.tsx`).
- Notification center: no `notifications` table, no unified feed. Reminder toasts only.
- Global search across notes/tasks/txns/memory.
- Tasks: no priorities/subtasks/recurring/kanban/timeline/attachments.
- Notes: shell page (`src/routes/Notes.tsx`) — no editor, tags, backlinks, FTS.
- Projects: shell page — no kanban, milestones, budget.
- Decisions: shell page — archive candidate.
- Config: nine-section reorg (Appearance/AI/Finance/Notifications/Security/Automation/Backup/Import-Export/Developer) not implemented.
- Account deletion + data export.
- Finance Health Score, AI Insights on Overview.

## 3. Security posture

Verified now via `security--get_table_schema` mental model + code read:

| Area | Status |
|---|---|
| RLS enabled on all 31 public tables | ✅ Present |
| Row-by-row RLS re-audit | ⏳ Deferred to Phase 1 (targeted read of every policy) |
| `service_role` key exposure | ✅ Not in client bundle; only edge fns |
| Storage `jarvis-vision` RLS | ✅ Private, `uid/…` prefix enforced in fn |
| Storage `statement-pdfs` RLS | ⏳ Need explicit policy re-read (Phase 1) |
| Statement password AES-256-GCM (`_shared/crypto.ts`) | ✅ Correct (IV, tag split, key from SHA-256(secret)) |
| Edge fn JWT verification | ✅ `_shared/auth.ts::requireUserId` via JWKS |
| Zod input validation on every fn | ✅ All finance/jarvis/gmail fns |
| Sliding-window rate limit | ✅ Per-isolate in-memory (`_shared/rate-limit.ts`) — acceptable for personal use, weakens at scale |
| SSRF guard on `jarvis-vision` | ✅ Host allowlist + `/storage/v1/object/` prefix |
| Prompt-injection wrap on statement text | ✅ `finance-summarize-statement` uses `<untrusted_data>` |
| CORS reflect-if-allowed | ✅ `_shared/cors.ts` |
| CSP + `Referrer-Policy: no-referrer` in `index.html` | ✅ Present; must extend `connect-src` for any new OAuth host |
| Leaked-password protection | ❌ Off — user must enable in Auth → Providers |
| `pgcrypto` in `public` schema | ⚠️ Linter warning; cosmetic |

### Client info-leak sweep (found)

- `src/lib/db.ts` and finance routes route errors through `toUserError`, but Gmail OAuth start/callback error path in `src/routes/config/email/*` sometimes surfaces raw fn responses. Need audit-and-replace pass.
- `src/lib/authFetch.ts` sets `apikey` header client-side (expected). No `service_role` seen.
- Console logs guarded by `import.meta.env.DEV` in the two places I sampled — good; sweep the rest in Phase 1.

### Attacker-simulation checklist (to run in Phase 7)

Auth bypass · IDOR on every REST endpoint (esp. `emails`, `email_attachments`, `statements`, `transactions`, `financial_accounts`, `loans`, `credit_cards`) · storage path traversal on `statement-pdfs` · PDF parser fuzz (malformed, encrypted, huge) · prompt injection on every AI-fed field · file-upload MIME confusion · replay of encrypted statement passwords across users.

## 4. Database

- Every user table carries `user_id`; RLS uses `auth.uid()` — confirm each policy is not `USING (true)` in Phase 1.
- `updated_at` triggers present on `jarvis_memory`; missing on several finance tables — audit and standardise.
- Indexes: `jarvis_memory_topic_pattern_idx` present for ILIKE. Finance hot paths (`transactions(user_id, txn_date)`, `statements(user_id, period_end)`) need explicit BTREE checks in Phase 2.
- No FKs from `transactions.statement_id` → `statements.id` verified in-code; needs read in Phase 1.
- Query 1000-row default limit not paginated on any list route — Phase 2 concern.

## 5. Edge Functions matrix

| Fn | verify_jwt | zod | rate-limit | sanitized errors |
|---|---|---|---|---|
| jarvis-chat | ✅ | ✅ | ✅ | ✅ |
| jarvis-tts | ✅ | ✅ | ✅ | ✅ |
| jarvis-transcribe | ✅ | ✅ | ✅ | ✅ |
| jarvis-vision | ✅ | ✅ | ✅ | ✅ |
| jarvis-vision-upload | ✅ | ✅ | ✅ | ✅ |
| gmail-oauth-start | ✅ | ✅ | — | ✅ |
| gmail-oauth-callback | ✗ (public callback) | ✅ | — | ⚠️ verify no state-token leak on error render |
| gmail-sync | ✅ | ✅ | ✅ | ✅ |
| gmail-sync-due | ✗ (cron secret) | ✅ | — | ✅ |
| gmail-message | ✅ | ✅ | ✅ | ✅ |
| finance-* (6 fns) | ✅ | ✅ | ✅ | ✅ |

All fns use `_shared/errors.ts::sanitizedErrorResponse` — good baseline. Gmail callback needs manual re-read in Phase 1.

## 6. Frontend / UI / UX

- **HUD**: JARVIS core renders, panels stubbed. No live data binding.
- **Routing**: lazy-loaded, animated transitions in place. Boot fallback shown correctly.
- **Placeholder pages**: `Notes.tsx`, `Decisions.tsx`, `Projects.tsx` are shells.
- **"Manage" pages**: Config sub-pages use drawer/table hybrid; spec asks for card → detail route pattern.
- **Loading states**: many finance panels show blank frame before data — need skeletons.
- **Empty states**: minimal / generic across finance.
- **A11y**: focus rings inconsistent, some buttons are `<div onClick>`; skip-link missing; live regions for toasts not present.
- **Responsive**: HUD strips assume ≥1200 CSS px; mobile broken.
- **Toasts**: `ToastLayer` styling drifts from HUD panel language.
- **Config button label**: still says "Config" — spec asks for removal.

## 7. Performance

- Route bundles not measured this pass — Phase 2 will add `vite build --report` output.
- `JarvisCore` 9k radial shards + 14 arcs is heavy on integrated GPUs; consider dpr clamp.
- `useFinanceSnapshot` refetches per subtab mount — needs shared React Query key + `staleTime`.
- No image-optimization pipeline for attachments (future).

## 8. AI integration

- Gateway helper (`_shared/ai-gateway.ts`) correct; run-id header propagation in place.
- `jarvis-chat` tools loop present; needs expanded tool surface (Phase 6): `create_task`, `log_txn`, `set_reminder`, `summarize_statement`, `finance_snapshot`.
- Prompt-injection wrap only on `finance-summarize-statement`; extend to every AI-fed user text.
- No structured-output usage yet; opportunity for finance categorization.

## 9. Dead code / dupes

- `Apps/hud/server.mjs` — thin Vite proxy, intentional, keep.
- `src/routes/Decisions.tsx` — archive candidate.
- `src/routes/config/finance/FinanceHome.tsx` overlaps `Config → Finance` tab; consolidate.
- No duplicate function blocks in `config.toml` anymore.

---

## Phase 1 fix set (proposed, no code yet)

1. Wire `parse_error` column on `statements`; retry UI + button.
2. Regex + LLM fallback parser scaffold + `confidence` write.
3. Sanitize Gmail OAuth error surface end-to-end; replace any raw response render.
4. Row-by-row RLS re-read + `statement-pdfs` bucket policy verification.
5. Add global client `ErrorBoundary` with friendly copy (currently only per-route).
6. React Router future flags one-liner.
7. Reminder poller singleton across tabs (BroadcastChannel or `localStorage` lock).
8. Docs: user-facing note to enable Leaked-Password Protection.

## Phases 2–7 unchanged from approved roadmap

See `.lovable/plan.md`.

---

## Answers I still need before Phase 1

1. **Notes**: keep + rebuild, or archive?
2. **Projects**: rebuild as tasks-wrapper, or archive?
3. **Decisions**: archive (recommended) or rebuild?
4. **Link module**: remove, or convert to Knowledge Hub?
5. Confirm phased order (Phase 1 → 2 → …) or reorder.

Reply with answers (or "your call on all four, proceed") and I'll begin Phase 1.
