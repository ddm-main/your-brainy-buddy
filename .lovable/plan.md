
## Statements Pipeline + Config Cleanup — corrected plan

You're right — credit_cards is fully populated. Correcting the seed data and folding in your restructure of Config → Banks.

### Correction to the previous plan

Actual `credit_cards` in DB (all six link cleanly by bank + last-4):

| Card | Last-4 | Bank |
|---|---|---|
| Airtel AXIS | 2605 | Axis |
| Amazon Pay ICICI | 6003 | ICICI Bank |
| HDFC Millennia | 6560 | HDFC Bank |
| SBI BPCL | **6662** | SBI |
| SBI Cashback | **4814** | SBI |
| Yes Bank | 0337 | Yes Bank |

Note: BPCL is `6662` (not `XX62`) and Cashback is `4814` (not `XX14`). The re-link backfill uses these actual last-4s. **No seeding needed** — remove that step entirely.

Bank table has three duplicate "SBI" rows (image-11). Merge them: keep the one already referenced by cards, repoint any FKs, delete the orphans, add a `unique(lower(name))` constraint.

### A. Config restructure — remove standalone Banks tab

- Delete tab **Banks** from `src/routes/config/FinanceConfig.tsx` `SUBTABS`.
- Delete route `banks` and `BanksConfig` lazy import in the same file; remove `src/routes/config/BanksConfig.tsx` and card in `FinanceHome`.
- Introduce a shared **Indian banks combobox** `src/components/finance/BankPicker.tsx` (typeahead over a bundled `INDIAN_BANKS` list ∪ existing `banks` rows). On pick of a bundled bank that has no row yet, upsert into `public.banks` (case-insensitive dedupe) and return the id. Used by:
  - `AccountsConfig` — replaces the current Bank ▾ + "Or new bank" fields.
  - `CardsConfig` — same replacement in the add-card form.
  - Statements upload flow (`finance-upload-statement` invoker UI on `Statements.tsx`) — bank field.
- Bundled list: 40+ common Indian banks (SBI, HDFC Bank, ICICI Bank, Axis, Kotak Mahindra Bank, Yes Bank, IDFC FIRST, IndusInd, Federal, PNB, BOB, Canara, Union Bank, IOB, Central Bank, BOI, UCO, Karur Vysya, South Indian, RBL, AU SFB, Bandhan, DBS, HSBC, Standard Chartered, Citi, Deutsche, IDBI, J&K Bank, Karnataka Bank, Tamilnad Mercantile, DCB, CSB, Equitas SFB, Ujjivan SFB, Suryoday SFB, Fincare, ESAF, Jana SFB, Utkarsh SFB, plus card-issuer aliases: Amazon Pay ICICI, Airtel Axis, Flipkart Axis, Tata Neu HDFC). Living file `src/data/indianBanks.ts`.

### B. Statements pipeline — remaining work

Schema (migration)
- `statements.parse_reason` text
- `statements.parser_confidence` numeric
- `email_accounts.treat_all_as_finance` boolean not null default false
- Bank dedupe: merge duplicate SBI rows, add `unique index banks_name_lower_idx on banks(lower(name))`

Data (via `supabase--insert`, not migration)
- `UPDATE email_accounts SET use_case='finance', finance_only=true, treat_all_as_finance=true, sync_period_days=GREATEST(COALESCE(sync_period_days,30),365) WHERE lower(email_address)='07statement@gmail.com'`
- Backfill: for every `statements` row in `pending|failed|skipped`, re-run link resolution using `banks.name` slug + `credit_cards.masked_number`/`financial_accounts.masked_number` suffix match; write `parse_reason` and reset `status='pending'` where a link is now possible.
- Schedule `pg_cron` job for `gmail-sync-due` every 15 min (uses existing `SYNC_HOOK_SECRET`).

Edge functions
- `_shared/finance-parsers.ts`: extend `BANK_SLUG_MAP` (sbicard.com, alerts.sbi, emailstatements.hdfcbank.com, icicibank.com, amazonpay.*icici, yesbank.in, axisbank.com + Airtel Axis); add `unwrapForwarded()`; broaden last-4 regex; bypass sender allow-list when `treat_all_as_finance=true`.
- `_shared/finance-extract-core.ts`: new `resolveLinksV2({parsed, email, unwrapped}) → {credit_card_id, financial_account_id, loan_id, linked_bank_id, parse_reason, parser_confidence}`. Called on every `pending|failed|skipped` row before retry. Match: bank slug + last-4 `endsWith` OR strong subject-token on `card_name` (BPCL, CASHBACK, MILLENNIA, AMAZON PAY, AIRTEL, …).
- Password rotation: explicit override → saved `statement_password_rule` → `jarvis_memory` candidates → none. Encrypt+persist winning password on success via `STATEMENT_ENC_SECRET`. `parse_reason` in {`password_missing`, `password_failed`, `parsed_with_saved_password`, `parsed_with_user_password`}. Never log plaintext.
- Parser skeletons already exist in `_shared/statement-parsers/` (hdfc/icici/amazon-pay-icici/axis/yes/hdfc-account/icici-account/sbi-account) delegating to `generic`. Wire writer to persist `closing_balance, min_due, due_date, period_start/end, txn_count, parser_source, parser_confidence` in `finance-extract`, `finance-retry-statement`, `finance-upload-statement`, `_shared/statement-pdf.ts`.

Statements UI (`src/routes/finance/Statements.tsx`)
- Fixed-height scroll `max-h-[calc(100vh-260px)] overflow-y-auto` + sticky header.
- Columns: Date · Bank · Linked card/account · Subject/Sender · Period · Txns · Status · Reason · Actions.
- Row actions: **View PDF** (`finance-statement-pdf-url`), **Re-link & retry**.
- Toolbar: **Retry all pending**, **Re-sync 07statement inbox**.
- Filter chips: bank, status, unlinked-only. `parse_reason` shown muted under status pill.

### C. Email Config bugs

1. **Reconnect only when needed.** In `EmailAccountsList.tsx` show Reconnect only if `sync_status==='error' && /invalid_grant|unauthorized|insufficient_scope|token|refresh/i.test(last_error)`, OR `!refresh_token`, OR permission scope drift after `connected_at`. Otherwise render Sync + Rules only.
2. **Redundant text.** `EmailHome.tsx`: collapse tiles that all route to `/config/email/list` into one "Mailboxes" card; hide `OTHER` purpose chip on rows.
3. **Daily auto-sync not firing.** `gmail-sync-due` exists but no cron scheduled. Create `pg_cron` job `gmail-sync-due-every-15m` calling the function URL with `x-cron-secret: <SYNC_HOOK_SECRET>` header (via `supabase--insert`, not migration, since URL + secret are project-specific). Verify `last_synced_at` advances afterwards.
4. **`/config/email/undefined` after Reconnect.** In `gmail.startOAuth` caller (`EmailAccountsList.connect`), when the popup pre-opens `about:blank` and the edge fn returns no `url`, the popup navigates to string `"undefined"` resolved against opener. Fix: throw `GmailApiError` when `!url`; `popup.close()` in `finally` on failure; same guard on non-popup fallback.
5. Defensive UI: `sync()` result uses `r.inserted ?? 0` / `r.total ?? 0`; `applyOAuthResult` accepts `event.source === opener` origin check; `AccountRulesDrawer` auto-bumps `sync_frequency` from `manual → daily` when `use_case` set to `finance`.

### D. Execution order

1. Migration: schema cols + bank unique index + duplicate-SBI merge.
2. `supabase--insert`: onboard `07statement@gmail.com`, backfill re-link across statements, schedule `pg_cron`.
3. Frontend: create `BankPicker` + `indianBanks.ts`; remove Banks tab/route/card; swap Bank fields in Accounts/Cards/Statements.
4. Edge fns: extend slug map, `unwrapForwarded`, `resolveLinksV2`, password rotation, persist new fields.
5. Statements UI redesign + Email Config bug fixes C1–C5.
6. Deploy affected edge functions.
7. Verify: read-only SQL for statement status/link/reason breakdown; cron `job_run_details`; Playwright walk of Statements (scroll, View PDF, retry one SBI + one HDFC row).

### E. Out of scope

Real HDFC/ICICI/Axis/Yes parser bodies (skeletons only); Gmail OAuth scope changes; UI outside Statements + Email Config + Accounts/Cards bank-picker swap.
