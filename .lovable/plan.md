
# Repo Cleanup & Refactor Plan

Goal: Reduce root clutter, delete dead weight, and refactor the handful of oversized files. Preserve `.claude/` skills and the `.gitignore`. This is a mechanical cleanup — no behavior changes to shipping features.

## 1. Delete (unwanted files)

**Tests** (per your request):
- `tests/` (entire folder: `escapePgrst.test.ts`, `safeFetch.test.ts`)
- `vitest.config.ts`
- Remove `vitest` + `@vitest/*` deps from `package.json`
- Remove `test` script from `package.json`

**.codex tooling**:
- `.codex/` (whole folder)

**Stale / duplicate markdown** (JARVIS "OS" folders that duplicate content and pollute root):
- `AGENTS.md` (duplicate of `CLAUDE.md`, byte-identical)
- `Dashboard.md`, `Inbox/`, `Archive/`, `Areas/`, `Resources/`, `Projects/` (JARVIS notes — not app code; you're switching editors, these aren't consumed by the app)
- `System/` (memory/logs/protocols — same reason)
- `.lovable/audit-2026-07.md`, `.lovable/plan.md` (stale audit notes; superseded by `Projects/jarvis/audit-2026-07.md` which also goes)
- `Apps/hud/` (unused separate app scaffold — nothing imports it)
- `content-os/` (unused data folder)

Keep at root: `README.md`, `CLAUDE.md` (single source of agent instructions).

> If you want to preserve any of the JARVIS markdown (memory/logs), tell me before I run the delete — otherwise everything above goes.

## 2. Refactor oversized files

Only touch files >400 LOC that are genuinely unwieldy. Extract by concern, keep public API stable, no logic changes.

| File | LOC | Split into |
|---|---|---|
| `src/lib/db.ts` (895) | data access grab-bag | `src/lib/db/` → `client.ts`, `accounts.ts`, `cards.ts`, `loans.ts`, `transactions.ts`, `statements.ts`, `subscriptions.ts`, `index.ts` (re-exports) |
| `src/components/core/JarvisCore.tsx` (653) | monolithic HUD shell | extract `useJarvisBoot`, `useJarvisHotkeys` hooks + `JarvisLayout` presentational component |
| `src/components/core/JarvisConversation.tsx` (500) | chat + streaming + tool UI | extract `useConversationStream` hook, `MessageBubble`, `ToolCallCard` |
| `src/routes/Home.tsx` (502) | dashboard | extract `HomeWidgets/*` (each tile becomes own file) |
| `src/components/hud/VoiceBar.tsx` (447) | mic + STT + TTS + waveform | extract `useVoiceCapture` hook, `Waveform` component |
| `supabase/functions/jarvis-chat/index.ts` (663) | chat edge fn | split into `tools.ts`, `stream.ts`, `quota.ts`, keep `index.ts` as thin handler |

`src/integrations/supabase/types.ts` (1919) is generated — leave alone.

## 3. Folder consolidation

Root today has 15+ non-code folders. After cleanup, root becomes:

```
.claude/  .agents/  .workspace/         ← agent skills (kept)
.lovable/                                ← keep (empty except mcp/config)
src/  supabase/  public/                 ← app
index.html  package.json  tsconfig.json  vite.config.ts  eslint.config.js  lovable.toml
.env.example  .gitignore  .prettierrc  .prettierignore  .mcp.json
README.md  CLAUDE.md
bun.lock  package-lock.json
```

Also inside `src/`:
- Merge `src/lib/*` unrelated utilities into subfolders: `src/lib/finance/` (financeMetrics, loanCalc, taxCalc, investmentCalc, reconciliation, recurringDetector, subscriptionAudit, useFinanceSnapshot, growwImport), `src/lib/jarvis/` (jarvisChat, jarvisTools, briefing, reminders), `src/lib/media/` (stt, tts, vision, screenShare, weather), `src/lib/core/` (authFetch, db, cn, errors, gmail, useSession). Update imports.

## 4. Code-quality pass (industry-standard, low-risk)

- Remove unused imports/vars flagged by `eslint --fix` (run once, commit).
- Remove commented-out code blocks.
- Drop the one `package-lock.json` OR `bun.lock` — you use bun (bun.lock stays, delete `package-lock.json`).
- Ensure every route file is default-exported and lazy-loaded from `App.tsx` (already partially done in Finance).
- Add `"sideEffects": false` to `package.json` for tree-shaking.

## 5. Verification

After each phase: `bun run build` (already auto-run by harness) — must pass. No manual test suite since tests are being removed per your instruction.

## Out of scope

- No feature changes, no UI changes, no schema changes.
- No touching `src/integrations/supabase/types.ts` (generated).
- No edge-function behavior changes beyond the file split.

## Technical notes

- All deletes via `rm`/`git rm`; all moves via `mv` in shell.
- Import rewrites done with `rg -l ... | xargs sed -i` after moves.
- Preserved: `.claude/**`, `.agents/**`, `.workspace/**`, `.gitignore`, `bun.lock`, `.env.example`.

Confirm and I'll execute in one pass.
