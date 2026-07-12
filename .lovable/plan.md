# Phase 1 — Audit report + preview fix + Finance overhaul

The full request is multi-week work across every module. This plan covers **Phase 1 only** per your selection: a written audit of the whole app, the blank-preview fix, and the Finance module end-to-end (highest priority). HUD, Tasks, Notes, Projects, JARVIS/AI, Notifications, Config, and the deep security pass are queued for later phases — each will get its own plan before I build.

---

## Part A — Application Audit Report (delivered as `Projects/jarvis/audit-2026-07.md`)

I'll write a single audit document covering every module. Findings are grouped by severity. I'll capture — not fix in this phase — anything outside Finance/preview.

**What I already know from this session** (goes into the report verbatim):

- **BLOCKER — edge fn ↔ DB signature mismatch.** `jarvis-chat` and `jarvis-tts` logs show `Could not find the function public.increment_jarvis_usage(_endpoint, _requests, _tokens, _user_id)`. The DB function only accepts `(_user_id, _requests, _tokens)` — no `_endpoint`. Every chat and TTS call is currently silently failing quota accounting and likely 500-ing on strict paths. Fix in Phase 1 (touches Finance-adjacent shared code).
- **HIGH — preview blank.** Local sandbox renders the auth screen (verified via Playwright); the hosted preview iframe shows a black frame. Console logs from the hosted preview show React Router warnings, meaning React mounts — so the blank is not a JS init crash. Likely cause: an early `AmbientLayer` / `JarvisCore` full-viewport black canvas painting over content before the auth card mounts, or the vite HMR websocket failing on the preview host (I'll confirm before editing).
- **HIGH — auth signup lock.** `block_new_signups` trigger hardcodes a single UUID. Fine for personal use; document it, don't remove it.
- **MEDIUM — env var drift.** `.env.example` standardises on `VITE_SUPABASE_PUBLISHABLE_KEY`, but `authFetch.ts` and edge functions expect it too; older code in the tree still reads `VITE_SUPABASE_ANON_KEY` in a few edge-fn tests. Consolidate.
- **MEDIUM — CSP + no-referrer.** `index.html` sets a locked-down CSP and `Referrer-Policy: no-referrer`. Good, but blocks any future OAuth callback flows unless whitelisted. Document.
- **MEDIUM — RLS grants.** `security--get_scan_results` still lists `SUPA_auth_leaked_password_protection` per project history. Not in Phase 1 scope but recorded.
- **MEDIUM — dead/placeholder modules.** `Notes`, `Decisions`, `Projects` routes are lazy-loaded shells with minimal functionality. Recommendation: retain Notes (attach to Finance for statement annotations), archive Decisions until re-designed, keep Projects as a thin wrapper on tasks.
- **LOW — HUD widgets.** `HudPanel` / `KineticNumber` / `JarvisCore` render but the panels for Mission Control / Signals / Pulse read stubbed data. Full HUD redesign is Phase 2.
- **LOW — router deprecation warnings.** React Router v6 → v7 future flags. Trivial follow-up.

The report will also list every route file, every edge function, every DB table's RLS posture, and every unused helper — I'll walk the tree and capture them systematically.

---

## Part B — Preview blank-screen fix

Two-step investigation, then a bounded fix:

1. Load `https://id-preview--…lovable.app/` in headless Playwright with an extended `networkidle` wait, capture screenshots at t=2s / t=6s / t=12s, and dump the DOM after mount. This tells me whether the auth card actually renders and something paints over it (z-index/CSS bug) or React never gets past `BootFallback`.
2. Compare hosted-preview console/network to my local run. If the hosted preview is missing `VITE_SUPABASE_PUBLISHABLE_KEY` at build time (Lovable preview may still inject the legacy `VITE_SUPABASE_ANON_KEY` name), `createClient` initialises with `undefined` → `supabase.auth.getSession()` never resolves → `useSession.ready` stays `false` → the preview shows only the boot fallback (which is very low-contrast text — could read as blank at a glance).

**Fix targets `src/integrations/supabase/client.ts` only:**

- Read the key as `VITE_SUPABASE_PUBLISHABLE_KEY ?? VITE_SUPABASE_ANON_KEY` so old and new env-var names both work.
- If either `SUPABASE_URL` or the resolved key is empty, `console.error` a clear diagnostic AND surface a visible error banner (via a new `<AppBootError/>` component rendered in place of the router) so future misconfig is never silent.
- No other files touched for the preview fix.

Verification: Playwright against localhost (must still show auth screen unchanged) + reload the hosted preview.

---

## Part C — Finance module overhaul

Ordered by impact. Each subsection lists the concrete edits.

### C1. Fix the quota RPC signature mismatch (blocker for every finance edge fn)

`supabase/functions/_shared/rate-limit.ts` calls `increment_jarvis_usage` with a shape the DB function doesn't accept. Migration:

- `CREATE OR REPLACE FUNCTION public.increment_jarvis_usage(_user_id uuid, _endpoint text, _requests int DEFAULT 1, _tokens bigint DEFAULT 0)` and stop upserting by `(user_id, day)` — key by `(user_id, day, endpoint)` so per-endpoint caps actually enforce.
- `jarvis_usage_daily` gets an `endpoint text NOT NULL DEFAULT 'legacy'` column and a new unique index; existing rows are backfilled to `'legacy'`.
- Grants stay unchanged.

### C2. Statement upload / password saving

`finance-set-statement-password` and `finance-upload-statement` are structurally fine but three real bugs are visible:

- `applyParsedStatementResult` in `finance-extract-core.ts` may silently swallow parse failures — I'll enumerate on the returned `parse_status` and expose a `parse_error` column on `statements` so the UI shows why parsing failed instead of an infinite "pending".
- `STATEMENT_ENC_SECRET` is a runtime edge-fn secret; verify it's set via `secrets--fetch_secrets` before any password-save UI test. If missing, `add_secret` before merging.
- Client-side, `Statements` in `Finance.tsx` currently has no re-upload / retry with password UI — I'll add an inline "provide password & retry" affordance that calls `finance-retry-statement`.

### C3. Transactions accuracy

- Replace the current regex-only `finance-parsers.ts` for statement PDFs with a two-stage pipeline: regex-first for banks we've seen (HDFC, ICICI, SBI cards, Axis), fallback to a bounded LLM extraction via `google/gemini-3-flash-preview` on unrecognised layouts. Confidence score persisted per row (already have the column).
- Add `merchant`, `category`, `payment_mode` columns to `transactions` (if missing — verify first) and enrich in a post-parse step using a small deterministic lookup table + fuzzy match against known subscription/merchant patterns.
- Add a `reconciliation_matches` UI that surfaces suspected duplicates and missing txns, one-click confirm/dismiss.

### C4. Credit cards & loans

- Cards detail page (new route `/finance/cards/:id`): balance, limit, utilization ring, statement history, outstanding, due date, rewards ledger, per-card txns table, "paid from account" resolver based on reconciled txns.
- Loans redesign (new route `/finance/loans/:id`): EMI/principal/interest/tenure calculator (already have `loanCalc.ts` — extend), amortization table, prepayment tracker, auto-detect EMI debits by matching `loan.emi_amount ± 1%` on the linked account.

### C5. Subscriptions auto-detection

- Nightly cron edge fn `finance-detect-subscriptions`: groups txns by normalised merchant, flags ≥3 recurring hits with stable cadence (monthly / annual), inserts into `subscriptions` with `auto_detected=true`.
- UI: renewal calendar, duplicate/price-hike/unused flags.

### C6. Interconnection

Single `useFinanceSnapshot` hook already exists — extend it into a query graph:

```text
statement ── parses ──► transactions ── enrich ──► merchant/category
       │                        │
       │                        ├─► credit_card.utilization
       │                        ├─► loan.next_emi
       │                        ├─► subscription.next_renewal
       │                        └─► financial_goal.progress
       └─► dashboard tiles ◄──── HUD / Notifications
```

Each write path fires a small `queryClient.invalidateQueries` for the downstream keys — no separate pub/sub. Everything reactive in one round-trip.

### C7. UI polish (Finance only, no other modules)

- Every finance card in `FinanceHome` and `AccountsConfig`, `CardsConfig`, `LoansConfig`, `SubscriptionsConfig`, `GoalsConfig` becomes clickable → routes to a detail page with inline editing.
- Kill the separate "Manage" sub-pages inside `config/finance/*` — merge into the detail routes.
- Consistent loading (skeleton HUD scanlines), empty (JARVIS voice copy), and error states.

---

## Part D — What's explicitly NOT in Phase 1

- HUD widgets / Mission Control / Signals / Pulse redesign
- Tasks / Notes / Decisions / Projects modules
- JARVIS voice/chat/memory upgrades
- Global notification system
- Config-page reorg
- Deep security pass (attacker simulation, XSS/CSRF/IDOR, PDF-parser hardening beyond what Finance needs, account deletion flow)
- SEO, accessibility sweep, react-router v7 flags

Each of these will land as its own plan when you're ready to move to Phase 2.

---

## Deliverables at end of Phase 1

1. `Projects/jarvis/audit-2026-07.md` — the full audit report (all modules).
2. Preview renders on both local sandbox and hosted preview.
3. Quota RPC fixed → chat/TTS/finance edge fns stop erroring.
4. Finance module: statements upload+parse+retry works, transactions enriched, cards/loans/subscriptions detail pages live, everything wired through the query graph.
5. Migration files for every schema change (each with grants + RLS).
6. Playwright smoke pass: login → upload a sample statement → see it parse → see txns appear on the card → see subscription auto-detected.

Approve this and I'll start with the audit doc + preview fix in the first build turn, then move down to C1→C7.
