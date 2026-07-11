# Fix: local run fails — missing Supabase env vars

## What's happening

The Vite frontend (`src/integrations/supabase/client.ts`) reads
`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` at build time from a
root `.env`. Locally that file doesn't exist (it's gitignored), so the client
initializes with `undefined` and the app can't reach Supabase. In the Lovable
sandbox these vars are injected automatically; on your machine you have to
create the file once.

The `.mcp.json` note about `SUPABASE_PROJECT_REF` / `SUPABASE_ACCESS_TOKEN` is
separate — those only power the Supabase MCP server used from Claude Code,
not the running app. But the same README is the natural place to document
both.

## Plan

1. **Create `.env.example` at repo root** (committed; `.gitignore` already
   allow-lists it) with the two required frontend vars plus the optional
   MCP vars, using the known project values as placeholders:

   ```
   # Frontend (Vite) — required to run the app locally
   VITE_SUPABASE_URL=https://ybtaxgstmxnlwurkritg.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=<anon key from Supabase dashboard>
   VITE_SUPABASE_PROJECT_ID=ybtaxgstmxnlwurkritg

   # Supabase MCP server (Claude Code only — not needed to run the app)
   SUPABASE_PROJECT_REF=ybtaxgstmxnlwurkritg
   SUPABASE_ACCESS_TOKEN=<personal access token>
   ```

   The real anon key is public (safe to commit) — I'll inline it so
   `cp .env.example .env` is enough to boot.

2. **Update `System/Backend/README.md`** — add a short "Running the app
   locally" section at the top explaining:
   - copy `.env.example` → `.env`
   - `npm ci && npm run dev`
   - the MCP env vars are only needed if you want `/sync` from Claude Code

3. **Update root `README.md`** with the same one-liner so new clones don't
   have to dig into `System/Backend/`.

No code changes, no schema changes — just the env template and docs. After
this, `cp .env.example .env && npm run dev` boots cleanly.
