## Goal

Stop treating banking mail as generic inbox items. On every Gmail sync, detect finance emails, extract structured records, and file them into `transactions`, `statements`, `credit_cards`, `loans`, and investment entries — auto-matched to the right bank/card/loan.

## 1. Detect finance mail on ingest (all accounts, not just `finance_only`)

In `_shared/gmail-sync-core.ts`, after inserting each `emails` row:
- Check sender domain against `FINANCE_DOMAINS` (already exists) + subject regex for txn/statement/SIP/EMI/CAS/OTP-debit keywords.
- If match → set `emails.finance_related = true` and enqueue for extraction (see §3).

This runs for every connected mailbox, so a mixed personal Gmail still gets its bank alerts picked up without forcing `finance_only`.

## 2. Extraction rules (`_shared/finance-parsers.ts`, new)

Regex-first per bank, AI-fallback for the rest. Each parser returns a normalized record + confidence.

| Email pattern | Extract → target table |
|---|---|
| "debited/credited by INR X at MERCHANT on DATE" (HDFC/ICICI/Axis/SBI/Kotak/YES/IDFC/Amex) | `transactions` (txn_type, amount, merchant, txn_date, ref_no) |
| UPI alerts ("VPA X paid Y", "received from Z") | `transactions` + payer/payee, category "UPI" |
| "Your credit card statement is generated" + PDF attachment | `statements` (statement_type=`credit_card`, period, statement_date) |
| Bank statement (monthly account statement PDF) | `statements` (statement_type=`bank`) |
| "EMI of X debited toward loan LN…" | `transactions` (category "EMI"), update `loans.outstanding_amount` if delta given |
| SIP confirmation / MF purchase / CAS (Motilal, CAMS, KFintech, CDSL) | `transactions` (category "investment") + `statements` (statement_type=`investment` when CAS PDF) |
| Card bill payment success (CRED, autopay) | `transactions` credit against card |

Matching to `credit_cards` / `financial_accounts` / `loans`:
1. `finance_email_rules` (bank_id/card_id/loan_id + sender/subject/attachment patterns) — exact match wins.
2. Fallback: last-4-digits regex in body/subject → lookup by `masked_number` suffix.
3. Fallback: sender domain → `banks` row (single bank/card) → link.

Anything below confidence threshold lands with `linked_*` null and shows in a "Needs review" list.

## 3. Extractor edge function (`finance-extract`, new)

- Called at the end of `gmail-sync` and by `gmail-sync-due` for each account after its sync completes; also exposed as a standalone POST for retries.
- Loads recent `emails` where `finance_related = true` and no matching row in `transactions.source_email_id` / `statements.source_email_id`.
- For each: fetch full body (reuse `gmail-message`), run parsers, insert into `transactions`/`statements`. Attach PDFs via `email_attachments` (storage: new `finance-statements` bucket, service-role write).
- Idempotent: dedupe by `(user_id, source_email_id, kind)`; safe to re-run.

Add columns via migration:
- `transactions.source_email_id uuid`, `transactions.external_ref text`, `transactions.confidence numeric` (all nullable, indexed on source_email_id).
- `statements.source_email_id` already exists; add `statements.source` text default `'email'`.
- GRANTs preserved (columns are additive).

## 4. UI

- **Finance → Overview**: add "Auto-extracted this week" tile (count + link to Txns filtered `source='email'`).
- **Finance → Transactions**: add filter chips `all / auto / manual / needs review`; row shows source email link when present.
- New **Finance → Statements** tab: list `statements` rows with type, period, linked account/card, "open email" + "download PDF" actions.
- New **Finance → Investments** sub-view under Txns (category filter = investment) with running holdings note.
- **Inbox** stays as-is for non-finance mail; finance-tagged rows still show but with a "→ txn" quick-link if extracted.

No changes to the Inbox filtering behavior itself — the user isn't asking Inbox to hide anything, just wants Finance to reflect the data.

## 5. Scheduling

- Reuse `gmail-sync-due` cron (already every 15 min): after each account sync, invoke `finance-extract` for that account. No new cron entry.
- Manual "↻ re-extract" button on Finance → Overview to reprocess the last 90 days.

## 6. Rollout order

1. Migration: new columns on `transactions`/`statements` + `finance-statements` storage bucket.
2. `_shared/finance-parsers.ts` with regex table + unit tests (`tests/financeParsers.test.ts`).
3. Hook auto-tagging into `gmail-sync-core.ts`.
4. `finance-extract` edge function + wire into sync flow.
5. Finance UI: Statements tab, Txns source filter, Overview tile, Investments view.
6. Backfill: one-off invocation of `finance-extract` with `since=90d` for existing emails.

## Technical notes

- Regex parsers stay server-side; PDFs parsed only when text extraction is trivial (statements table stores metadata + storage path, deep PDF parsing is a later pass).
- AI fallback uses Lovable AI Gateway (`LOVABLE_API_KEY`) with a strict JSON schema; only invoked when regex fails and email matches finance sender/subject heuristics — keeps token spend bounded.
- Idempotency key `(user_id, source_email_id)` prevents double-inserts on re-sync.
- `linked_bank_id` / `linked_card_id` on `emails` populated during extraction so future filters ("all HDFC card mail") are cheap.
- No change to how OAuth scopes work; readonly is sufficient for all of this.
