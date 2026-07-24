# Fix logout access + hide Kotak setup for non-admins

Two independent issues, both traced.

## 1. Logout is unreachable for the `user` role

**Root cause (verified):**
- `Sign out` button lives only in `src/routes/config/ConfigHome.tsx` (line 87).
- `/config/*` is wrapped in `<AccessGate section="config">` in `src/App.tsx` (line 164).
- A `user`-role account without the `config` section can't reach `/config`, so there is no path to `supabase.auth.signOut()`. The gear icon in `TopBar` navigates to `/config` unconditionally and lands on the access-denied screen.

**Fix:** Put the sign-out control in `TopBar` where every authenticated user sees it.
- Replace the current gear button in `src/components/hud/TopBar.tsx` with a small user menu (popover) anchored on the same icon:
  - Shows the signed-in email (from `supabase.auth.getUser()`).
  - `Configuration` link → `/config` (rendered only when `sections.has("config") || role === "admin"`).
  - `Sign out` item → calls `supabase.auth.signOut()`, then `useAccessStore.reset()` and navigates to `/auth` (the app's existing auth route).
- Close on outside click, same pattern already used for the notifications popover.
- No route/schema changes; ConfigHome's sign-out button stays as a secondary entry for admins.

## 2. Normal users are prompted for Kotak Neo credentials

**Root cause (verified):**
- Kotak is a shared broker session that only the workspace admin should configure. RLS on `market_api_settings` is per-user (`auth.uid() = user_id`), so a normal user querying it gets an empty result — but the UI still exposes Kotak surfaces to them:
  - `src/routes/Market.tsx` line 112 mounts `<KotakReconnectModal />` for everyone. For a fresh user it won't trigger, but the "Kotak Disconnected" surface is not something a non-admin should ever see.
  - `src/routes/market/Settings.tsx` shows the full Kotak card with "Add credentials", MPIN/TOTP fields, and "Login to Kotak" to every visitor of `/market/settings`.
- Intent: only admins configure/reconnect Kotak. Users just consume the resulting live data.

**Fix:** Gate all Kotak setup UI behind `role === "admin"`.
- `src/components/market/KotakReconnectModal.tsx`: early-return `null` when `useAccessStore.role !== "admin"`. Reconnect prompts stay for admins only.
- `src/routes/market/Settings.tsx`:
  - When `role !== "admin"`, hide the Kotak provider card entirely and render a short read-only note: "Broker session is managed by an admin — live market data is provided automatically." Yahoo (fallback/public data) card remains visible read-only.
  - Disable the `market-kotak-*` action buttons for non-admins as a defense-in-depth measure (the RLS on the settings row already blocks writes; this just prevents a confusing "permission denied" toast).
- No edge-function or database changes — the server side is already scoped correctly by RLS, this purely removes UI that shouldn't be shown.

## Files touched

- `src/components/hud/TopBar.tsx` — add user menu with sign-out.
- `src/components/market/KotakReconnectModal.tsx` — admin-only guard.
- `src/routes/market/Settings.tsx` — hide Kotak card / actions for non-admins; add read-only note.

## Out of scope

- No changes to `AccessGate`, RLS policies, or edge functions.
- No changes to Yahoo fallback behavior — non-admins keep seeing market data exactly as they do today, minus the broker prompts.
