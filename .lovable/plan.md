## Goal

Clicking anywhere on an Account tile or Card tile navigates to that item's dedicated detail page (which already exists and shows balance/utilization, statements, transactions, and linked items). Editing/deleting/logging-a-payment moves into the detail page so the list stays a clean, click-through grid.

## Current behavior

- `src/routes/finance/Accounts.tsx` and `src/routes/finance/Cards.tsx` toggle an **inline edit expander** on tile click. A small `details →` link in the corner is the only way to reach the real detail route.
- Detail routes `/finance/accounts/:id` (`AccountDetail.tsx`) and `/finance/cards/:id` (`CardDetail.tsx`) already exist and render statements + recent transactions + linked entities. They currently have no inline edit UI.

## Changes

### 1. `src/routes/finance/Accounts.tsx` — tile becomes a link

- Wrap each tile in a `<NavLink to={`/finance/accounts/${a.id}`}>` (or use `useNavigate` in the onClick).
- Remove the inline expander, `openId`, `edit`, `save`, `remove`, `balanceTouched`, and related state/handlers.
- Drop the small "details →" corner link (the whole tile is now the target).
- Keep the summary rendering (nickname, chips, bank, mask, balance).
- Add hover affordance (border/background shift) so the tile reads as clickable.

### 2. `src/routes/finance/Cards.tsx` — same treatment

- Wrap each tile in a link to `/finance/cards/${c.id}`.
- Remove the inline expander, `openId`, `edit`, `save`, `remove`, `payment`, `logging`, `logPayment`, and related state.
- Drop the "details →" corner link.
- Keep the summary chips (bank, utilization %, reward badge) and metadata line.

### 3. `src/routes/finance/AccountDetail.tsx` — add edit + delete

- Add an "Edit" toggle in the header that opens the same form previously in `Accounts.tsx` (nickname, type, bank, last 4, statement cycle day, source email, current balance with as-of stamping, notes). Reuse `db.accounts.update` and `db.accounts.remove`.
- Add a "Delete" action with confirm; on success navigate back to `/finance/accounts`.
- After save, refetch the account row.

### 4. `src/routes/finance/CardDetail.tsx` — add edit + delete + log-payment

- Add an "Edit" toggle with the fields previously in `Cards.tsx` (name, bank, last 4, limit, bill/due day, reward type/rate, autopay, notes). Reuse `db.cards.update` / `db.cards.remove`.
- Add the "log bill payment" block (paid-from account, amount, date) that currently lives inside the inline expander in `Cards.tsx`, using `db.transactions.create`. After logging, refetch statements/txns.
- Delete action with confirm; on success navigate back to `/finance/cards`.

## Non-goals / not touched

- No schema changes, no `db.ts` (`src/lib/db/*`) changes.
- Loans, Goals, Investments detail pages already work off the same pattern and aren't in scope.
- Config pages (`AccountsConfig`, `CardsConfig`) stay as they are for creating new items.

## Verification

- Playwright: sign in, land on `/finance/accounts`, click an account tile — URL becomes `/finance/accounts/:id`, detail page shows balance + statements + txns. Edit nickname, save, back button returns to list with updated name.
- Repeat on `/finance/cards`: click tile → `/finance/cards/:id`, edit + log-payment work, delete returns to list.
- No console errors; build passes.
