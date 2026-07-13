# Code Optimization & Refactor Plan

Applies industry-standard structure to the codebase: split oversized files, group related modules into feature folders, prune dead code, and tighten config. No behavior changes — pure structural refactor plus lint/typecheck cleanup.

## 1. Split oversized files (>400 LOC)

### `src/lib/db.ts` (895 LOC) → `src/lib/db/`
```text
src/lib/db/
  client.ts         # supabase client re-export + shared helpers (escapePgrst, safeFetch)
  accounts.ts
  cards.ts
  loans.ts
  transactions.ts
  statements.ts
  subscriptions.ts
  projects.ts       # getBySlug used by jarvisTools
  index.ts          # export const db = { accounts, cards, ... }
```
Public API preserved: `import { db } from "@/lib/db"` keeps working via `src/lib/db/index.ts`.

### `supabase/functions/jarvis-chat/index.ts` (663 LOC)
```text
supabase/functions/jarvis-chat/
  index.ts     # HTTP entry, CORS, auth, request parsing (~120 LOC)
  tools.ts     # tool definitions + execute() handlers
  stream.ts    # SSE stream construction, delta forwarding
  quota.ts     # rate limit + credit check
  prompt.ts    # system prompt builder
```

### `src/components/core/JarvisCore.tsx` (653)
- Extract `useVoiceSession`, `useHotkeys`, `useNavigatorBridge` hooks → `src/components/core/hooks/`
- Extract presentational `JarvisLayout.tsx` (grid/scaffold JSX)
- `JarvisCore.tsx` becomes wiring only (~150 LOC)

### `src/components/core/JarvisConversation.tsx` (500)
- `useConversationStream.ts` — stream state, deltas, abort
- `MessageBubble.tsx` — one message row
- `ToolCallCard.tsx` — tool input/output rendering
- Parent becomes list + composer only

### `src/routes/Home.tsx` (502) → widgets
```text
src/routes/Home.tsx           # grid + data fetch
src/routes/home/widgets/
  BriefingTile.tsx
  FinanceTile.tsx
  TasksTile.tsx
  ProjectsTile.tsx
  RemindersTile.tsx
  WeatherTile.tsx
```

### `src/components/hud/VoiceBar.tsx` (447)
- `useVoiceCapture.ts` — mic + STT state
- `Waveform.tsx` — canvas visualizer
- `VoiceBar.tsx` — layout + controls

## 2. Reorganize `src/lib/` into feature folders

Currently ~30 flat files. Group by domain:

```text
src/lib/
  db/                    # (from #1)
  finance/
    financeMetrics.ts
    investmentCalc.ts
    loanCalc.ts
    taxCalc.ts
    recurringDetector.ts
    reconciliation.ts
    subscriptionAudit.ts
    growwImport.ts
    useFinanceSnapshot.ts
  jarvis/
    jarvisChat.ts
    jarvisTools.ts
    briefing.ts
    reminders.ts
  media/
    stt.ts
    tts.ts
    vision.ts
    screenShare.ts
    weather.ts
  gmail.ts               # single file, stays flat
  core/
    authFetch.ts
    useSession.ts
    errors.ts
    cn.ts
```

All imports updated via search-replace across `src/`.

## 3. Prune

- `src/lib/errors.ts` — audit for unused exports, delete dead ones
- Remove commented-out `// open_url removed` blocks and TODO scaffolds where obsolete
- Run `eslint --fix` for import ordering + unused vars
- Delete `Apps/hud/server.mjs` shim if we can update `lovable.toml`; **skip** if still read-only (leave shim in place)

## 4. Config tightening

- `tsconfig.json`: add `"noUnusedLocals": true`, `"noUnusedParameters": true`, `"noFallthroughCasesInSwitch": true`
- `package.json`: sort scripts, keep `sideEffects: false`
- `.prettierrc`: already good, no change
- `eslint.config.js`: enable `import/order` if plugin present, otherwise leave

## 5. Verification

After each of the 6 file splits: `tsgo` typecheck + touch the app in preview. Any red → revert that step, no chained failures.

## Technical notes

- **Barrel files** (`db/index.ts`) keep public API stable — zero import churn outside the split file itself.
- **Edge function split** uses relative imports (`./tools.ts`) — Deno-friendly, no bundler needed.
- **No React component API changes** — extracted subcomponents are internal to each parent's folder.
- **Order of operations**: db split → lib reorg → component splits → edge fn split → config. Each step independently revertible.
- No dependency changes, no migrations, no route changes, no styling changes.

## Out of scope

- Business logic changes
- UI/UX redesign
- Test additions (tests were removed by user)
- Database schema changes
