# Fix the blank preview

## What I found

Loading the preview in a headless browser shows a white page with `root` empty and a repeated runtime error:

```text
Uncaught ReferenceError: __BUNDLED_DEV__ is not defined
```

That symbol comes from Vite's own HMR client (`@vite/client`), not from app code — nothing in the repo references it.

Cause: the running dev-server process reports **Vite 8.2.1**, but `node_modules/vite` on disk is now **8.1.4** (dependencies were reinstalled while the server kept running). The 8.1.4 client file is served, but the 8.2.1 server in memory never defines `__BUNDLED_DEV__` for it, so the HMR client throws on every page load and the app never mounts.

Secondary noise (not the blank screen): the live-tick relay in `Apps/hud/server.mjs` crash-loops because `.env` lacks `VITE_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`, and Node can't resolve `@supabase/auth-js` from `supabase-js`. It gives up after 5 tries and does not affect the HUD.

## Fix

1. Restart the dev server so the running process matches the installed Vite 8.1.4.
2. Reload the preview and confirm in the browser: no `__BUNDLED_DEV__` error, `#root` renders (auth screen or `/market`).
3. If the error persists, reinstall dependencies cleanly (`node_modules/.vite` cache dropped) so server and client are the same Vite build, then re-verify.

No application code changes are expected. If verification uncovers a second, app-level error behind the Vite one, I will report it before changing any source.

## Optional cleanup (say the word)

- Silence the relay crash-loop by having `Apps/hud/server.mjs` skip the relay when the required env vars are absent, instead of retrying five times.
