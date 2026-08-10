# Stabilize the Breakout preview

## Confirmed diagnosis

- The screenshot occurred while `/market/breakout` was returning an internal server error during a Vite restart.
- Immediately beforehand, the browser failed to load the lazy `Breakout` chunk (`Failed to fetch dynamically imported module`).
- The local route now returns HTTP 200 and the running Vite process matches the npm-installed version (`8.2.1`).
- Dependency resolution is still inconsistent: `package-lock.json` resolves Vite `8.2.1`, while `bun.lock` resolves `8.1.4`. A future install with the other package manager can recreate the server/client mismatch.
- The existing error boundary recognizes chunk-load failures, but only offers a manual reload.

## Fix

1. Pin Vite to one exact version and synchronize the npm and Bun lockfiles so installs cannot alternate between incompatible Vite clients.
2. Make stale lazy-chunk recovery automatic and loop-safe: on the first dynamic-import failure, hard-reload once; if it fails again, retain the existing visible recovery screen rather than reloading forever.
3. Correct the build guard so it compares the scripts loaded by the current document with the latest `index.html` immediately, instead of treating the first fetched deployment as the baseline for an already-stale tab.

## Verification

- Run the focused test suite and production build checks provided by the project harness.
- Open `/market/breakout` in a fresh browser session and confirm the page renders without an internal server response or chunk-load error.
- Simulate a stale chunk failure and confirm there is exactly one automatic reload, followed by normal rendering or the manual fallback if recovery is impossible.
- Confirm both lockfiles resolve the same Vite version.

## Technical scope

- Dependency manifest and lockfiles only for version alignment.
- `src/components/hud/ErrorBoundary.tsx` for one-shot lazy-chunk recovery.
- `src/lib/buildGuard.ts` for immediate stale-build detection.
- No market data, Supabase, or Breakout business-logic changes.