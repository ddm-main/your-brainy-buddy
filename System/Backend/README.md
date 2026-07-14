# JARVIS Backend — Supabase

Markdown files in this OS are the **working copy** (what JARVIS reads/writes every session). Supabase is the **structured system of record** — queryable from anywhere, and the foundation for a future web dashboard, mobile access, or n8n automations.

## Running the app locally

The Vite frontend needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` at build time. On a fresh clone:

```bash
cp .env.example .env      # at the repo root — real project values, anon key is public
npm ci
npm run dev
```

That is enough to boot the HUD. The MCP env vars below (`SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN`) are a **separate** concern — they only power the `supabase` MCP server used from Claude Code for `/sync`. The app does not read them.


## Architecture

```
Claude Code (JARVIS kernel)
   │  reads/writes
   ▼
Markdown files (source of truth)          Supabase (Postgres)
   Inbox/inbox.md            ──/sync──▶     inbox_items
   Projects/*/_overview.md   ──/sync──▶     projects + next_actions
   Areas/*/_overview.md      ──/sync──▶     areas
   System/Memory/*.md        ──/sync──▶     memories
   System/Logs/*.md          ──/sync──▶     daily_logs
```

Connection is via the official **Supabase MCP server** (configured in `.mcp.json` at the repo root, credentials via environment variables — nothing secret is committed).

## One-time setup

1. Create a free project at [supabase.com](https://supabase.com/dashboard) (any name, e.g. `jarvis-os`). Note the **project ref** — the 20-character id in the project URL: `https://supabase.com/dashboard/project/<ref>`.
2. Create a **personal access token**: Dashboard → Account → Access Tokens → Generate new token.
3. Set both as user environment variables (PowerShell):
   ```powershell
   [Environment]::SetEnvironmentVariable('SUPABASE_PROJECT_REF', '<your-ref>', 'User')
   [Environment]::SetEnvironmentVariable('SUPABASE_ACCESS_TOKEN', '<your-token>', 'User')
   ```
4. Restart Claude Code (so it picks up the env vars), open this folder, approve the `supabase` MCP server when prompted.
5. Run `/sync` — the first run applies `schema.sql` automatically, then pushes all current state.

## Tables

| Table | Mirrors | Key |
|-------|---------|-----|
| `memories` | `System/Memory/*.md` | category + content |
| `inbox_items` | `Inbox/inbox.md` | content, processed flag |
| `projects` | `Projects/*/_overview.md` | `slug` (folder name) |
| `next_actions` | project checkboxes | project_id |
| `areas` | `Areas/*/_overview.md` | `name` |
| `daily_logs` | `System/Logs/*.md` | `log_date` |

RLS is enabled on all tables with no anon policies — only JARVIS (via access token) can touch them. Add policies when a client app needs direct access.
