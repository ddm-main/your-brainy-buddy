---
name: sync
description: Sync the file-based OS state to the Supabase backend (memories, inbox, projects, areas, logs). Use when Deepak says "sync", "push to supabase", or after significant file changes.
---

Push file state → Supabase. Files are the source of truth; the database mirrors them.

**Transport** (proven path first):
1. **`db.mjs` utility** — write the SQL to a temp file, then `node System/Backend/db.mjs <file.sql>` (uses `SUPABASE_PROJECT_REF` + `SUPABASE_ACCESS_TOKEN` env vars; runs any SQL incl. DDL via the Management API). This is the verified default.
2. `supabase` MCP server tools, if configured.
3. REST fallback — PostgREST at `https://ybtaxgstmxnlwurkritg.supabase.co/rest/v1/<table>` with `apikey`/`Authorization: Bearer` = `$env:SUPABASE_SERVICE_ROLE_KEY` (data only, no DDL).
4. None available → tell Deepak the backend isn't connected (see `System/Backend/README.md`) and stop.

Steps:

1. **Preflight**: `select 'ok' from projects limit 1;` via db.mjs. If it errors with missing table, apply `System/Backend/schema.sql` first (db.mjs handles DDL fine).
2. **Sync each domain** (upsert, never blind-insert):
   - `Inbox/inbox.md` unchecked items → `inbox_items` (skip content already present unprocessed).
   - `Projects/*/_overview.md` → `projects` (match on `slug`) + their unchecked next actions → `next_actions` (mark done ones `done=true, completed_at=now()`).
   - `Areas/*/_overview.md` → `areas` (match on `name`; update `standard`, `health_check`).
   - `System/Memory/*.md` → `memories` (one row per bullet/entry; match on `category` + content prefix to avoid duplicates).
   - `System/Logs/*.md` changed since last sync → `daily_logs` (upsert on `log_date`, full file content).
3. **Record**: append "synced to Supabase (N rows touched)" to today's log.
4. Report a per-table summary: inserted / updated / skipped.

Escape single quotes in SQL string literals by doubling them. Batch statements where possible.
