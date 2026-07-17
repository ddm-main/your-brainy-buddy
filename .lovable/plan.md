## Goal

Rebuild the Statements page specifically for card-type rows so every field the user cares about is a real column — no collapsible expanded section. Non-card rows (accounts/loans) keep the existing compact layout so we don't regress those.

## New card table columns

When `filterType === "card"` (or the row's `statement_type === "card"`), render this exact column set:

1. **Card Name** — `credit_cards.card_name` (fallback: bank name + "card"). Bank name as small dim subtitle.
2. **Card No** — last 4 from `credit_cards.masked_number` (or `s.card_last4`), formatted `XX 6560`.
3. **Credit Limit** — `s.credit_limit` formatted as `₹ 2,25,000` (Indian grouping via existing `inr()`).
4. **Statement Date** — `s.statement_date` as `DD-MM-YYYY`.
5. **Billing Period** — `period_start → period_end` both `DD-MM-YYYY` (single line, wrap allowed).
6. **Total Amount Due** — `s.total_due` as `₹ 7,459`. Show `min ₹ …` dim underneath (min due is important enough to keep, but not a full column).
7. **Due Date** — `s.due_date` as `DD-MM-YYYY`. Red if overdue and unpaid.
8. **Transactions** — just the count `s.transactions_found`. Click opens a **Transactions modal** (uses existing `HudPanel`-style dialog) loading txns via existing `loadTxns(s)` logic. No inline expansion.
9. **Status** — parse status chip + payment chip inline.
10. **Validated** — `Yes` / `No`. On `No`, show the error/mismatch text inline (from existing `validationFor` + `explainParseError` + missing-fields logic). Tooltip carries full detail.
11. **Actions** — `PDF`, `retry`, `mark paid` / `clear payment`, `attach PDF` (when skipped), `link` (opens a small popover instead of the expanded panel for unlinked / needs-reparse rows).

Row height stays a single line per column; secondary info (bank, min due) uses the same row as small dim text — no second stacked row, no expandable region.

## Non-card behavior

Accounts and loans keep today's 5-column compact layout. Cards get the new 11-column layout. Header switches based on active `filterType`; the "All" view falls back to the compact 5-column layout so mixed data still fits.

## Modals / popovers (replace expanded row)

- **Transactions modal**: title `{card_name} · {period}`, table of txns (date, description, amount, txn_type). Reuses current `loadTxns` and rendering from the old expanded section.
- **Fix / link popover**: opens from Actions when the row is failed / unlinked / needs reparse. Contains the existing controls (link select, password field, retry, save link only, StatementReviewPanel for missing fields). Replaces inline expansion.

## Bug fixes bundled

- Format all dates through a single `fmtDMY(d)` helper (`DD-MM-YYYY`) — today mixes `toLocaleDateString()` and raw ISO like `2026-06-02`.
- Format all money through `inr()` (already Indian grouping) so `Credit Limit` displays `₹ 2,25,000` instead of the current `lim ₹ 4,40,000` shorthand.
- `Card No` falls back through `credit_cards.masked_number` → `s.card_last4` → `—` so parsed-but-unlinked rows still show a number when the parser found one.
- `Validated` column consolidates today's three signals (parse status incomplete, `validationFor` mismatch, missing fields) into one boolean + reason string, so "parsed · incomplete" no longer hides the real issue.
- Overdue styling: due date turns `--err` when `due_date < today` and `payment_status !== "paid"`.
- Remove the now-dead expanded-row code path and its `openId` state for card rows.

## Files touched

- `src/routes/finance/Statements.tsx` — new card table, modal, popover, helpers; remove expanded row for cards.
- (Optional) small helper `fmtDMY` colocated in the same file — no shared util changes needed.

No schema, edge function, or data changes. Frontend only.

## Out of scope

- Column sorting / resizing.
- Account and loan table redesign (kept as-is).
- Any parser or backend fix — this is purely presentation.
