## Goal

Convert `/config/email` into a multi-step hub with real per-account sync rules, fix the Config landing so it shows all sections, and add scheduled auto-sync via pg_cron.

---

## 1. Config landing (routing)

- Replace the `Navigate to /config/email` default in `src/routes/Config.tsx` with a **Config Home** grid.
- New `src/routes/config/ConfigHome.tsx`: card grid for Email, Banks, Accounts, Cards, Loans, Goals, Subscriptions, Projects. Each card shows description + live count from Supabase (e.g. "3 connected"). Sidebar tabs stay for quick nav inside a section.

## 2. DB migration — per-account rules

Single additive migration on `public.email_accounts` (all nullable / defaulted, no data loss):

| Column | Type | Default |
|---|---|---|
| `sync_frequency` | text | `'manual'` |
| `sync_period_days` | int | `30` |
| `use_case` | text | `'general'` |
| `finance_only` | bool | `false` |
| `finance_sender_filter` | text | `null` |
| `permission_level` | text | `'read'` |
| `auto_categorize` | bool | `true` |
| `notify_on_new` | bool | `false` |
| `max_per_sync` | int | `100` |
| `paused_at` | timestamptz | `null` |

RLS unchanged (existing per-user policy already covers new columns).

## 3. Edge function updates

**`gmail-sync`**
- Load new columns. If `paused_at` set → return `{ paused: true }` and skip.
- Build Gmail `q`: `newer_than:{sync_period_days}d in:inbox` + optional `from:(<finance domain list> [+ finance_sender_filter domains])` when `finance_only` or `use_case='finance'`.
- Use `max_per_sync` for `maxResults` (capped at 500).
- Finance domain list lives in `_shared/finance-senders.ts` (Chase, BoA, HDFC, ICICI, Axis, SBI, PayPal, Stripe, Razorpay, etc.).

**`gmail-oauth-start`**
- Compute scope list from `permission_level`: `read` → readonly only; `read_write` → readonly + modify. Persisted `scopes` column already captures granted scopes on callback.

**`gmail-sync-due`** (new)
- Called by cron. Selects accounts where `paused_at IS NULL`, `sync_frequency != 'manual'`, and `last_synced_at` older than the frequency interval. Invokes the same sync path for each (service-role, batched, best-effort with per-account error capture into `last_error`).

**pg_cron**
- Enable `pg_cron` + `pg_net`. Schedule `gmail-sync-due` every 15 minutes via `supabase--insert` (not migration, since the SQL embeds the project URL + anon key).

## 4. UI — `/config/email` split

`EmailConfig.tsx` becomes a router shell for `email/*` with these sub-routes/components:

- `email/EmailHome.tsx` — landing card grid: **Connect mailbox**, **Manage mailboxes**, **Sync rules**, **Sender filters**, **Recent activity**. Stat header: connected / syncing / errors.
- `email/EmailAccountsList.tsx` — existing list, extracted.
- `email/AccountRulesDrawer.tsx` — grouped rules editor:
  - *Sync*: frequency, period, max per sync, pause toggle.
  - *Purpose*: use case, finance-only, extra sender domains textarea.
  - *Permissions*: read vs read+write with "requires reconnect" warning when changed.
  - *Automation*: auto-categorize, notify on new.
  - Live monospace preview of the composed Gmail `q`.
  - Immediate `.update().eq('id', ...)` on change with toast.
- `email/RecentActivity.tsx` — last sync + `last_error` per account.

## 5. UX polish

- Keep the list rendered while refetching (no double-loader flash — mirrors Accounts/Contacts pattern).
- Landing card grid always renders (even with zero accounts) so **Connect mailbox** is always reachable.
- Typed-confirm delete dialog (must type the email address) replaces `confirm()`.
- Split single reconnect button into **Reconnect** (re-run OAuth) and **Update scopes** (visible only when `permission_level` was changed since last connect).
- `last_error` persisted (already a column) — surfaced in ErrorPanel and Recent Activity.
- A11y: label all inputs, `n` shortcut to add mailbox, focus trap in drawer.

## 6. Rollout order

1. Migration for new columns.
2. Types regenerate + `src/lib/db.ts` helper for `emailAccounts.update()`.
3. `gmail-sync` + `gmail-oauth-start` honour new fields; add `_shared/finance-senders.ts`.
4. Config Home landing + Email sub-routes shell.
5. Accounts list extraction + Rules drawer + Recent activity.
6. `gmail-sync-due` function + `pg_cron` schedule (via `supabase--insert`).

## Technical notes

- Gmail operators used server-side only: `newer_than:Nd`, `in:inbox`, `from:(a OR b)`. Client never passes raw `q`.
- Widening `permission_level` from `read` → `read_write` requires a full reconnect; token refresh alone cannot grant new scopes. UI enforces this.
- `pg_cron` job SQL is inserted (not migrated) because it embeds project-specific URL + anon key.
- All new columns are additive with defaults — existing rows keep working; no code path breaks before wiring.

```text
/config
  ├─ (index) ConfigHome  ── grid of section cards
  └─ email/
       ├─ (index) EmailHome        ── action cards + stats
       ├─ accounts  EmailAccountsList
       ├─ rules/:id AccountRulesDrawer
       └─ activity  RecentActivity
```
