# Project: Finance

**Outcome:** Every transaction, credit-card and bank statement from connected Gmail accounts is automatically tracked — expenses visible at a glance in the HUD and in `expenses.md`.
**Deadline:** none
**Status:** active · started 2026-07-08

## How it works
- The HUD server scans all connected Gmail accounts for transaction alerts (debits/credits/UPI) and statement emails.
- Ledger (machine-readable): `transactions.json` — deduped by Gmail message id.
- Report (human-readable): `expenses.md` — monthly totals + recent transactions + statements. Auto-generated on every scan; don't edit by hand.
- Trigger: "↻ scan" button in the HUD Finance panel, or `POST /api/finance/scan`.

## Next actions
- [ ] Register remaining accounts in the Finance section (statements show: ICICI, SBI Card, YES Bank, HDFC, Kotak, IDFC) with last-4 digits for auto-matching
- [ ] Reclassify the "Other" transactions once — JARVIS learns a rule from each correction

## Log
- 2026-07-08 — project created (via HUD)
- 2026-07-08 — auto-tracking wired: Gmail scan → transactions.json + expenses.md, Finance panel added to HUD
- 2026-07-08 — Finance section: accounts/cards/loans + goals registry (accounts.json), auto-categorization with learned rules, category breakdown, first accounts + Emergency-fund goal added
- 2026-07-08 — ✓ connected all three Gmail accounts; first scan: 89 transactions, 86 statements
