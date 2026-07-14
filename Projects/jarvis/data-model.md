# JARVIS — Data Model (prose, pre-SQL)

> Actual `CREATE TABLE` + GRANT + RLS SQL comes in Step 2's migration plan.
> This file is the source-of-truth entity list Step 2 will translate.

## A. Core

- **profiles** — full_name, timezone, currency, prefs.
- **app_settings** — key/value_json per user for feature flags & prefs.
- **tags** — name, color, type (task/note/project/finance).
- **entities** — id, type (person/vendor/bank/project/tool/place), name, metadata_json. Cross-module link target.
- **entity_links** — polymorphic link: (entity_id, target_type, target_id).

## B. Productivity / memory / work

**Tasks**
- `tasks` — title, description, status, priority, due_at, reminder_at, source, category, linked_project_id, linked_email_id, linked_account_id, linked_goal_id, owner.
- `task_recurrence_rules` — task_id, type, config_json.
- `task_activity` — task_id, action, meta_json.

**Notes / memory**
- `notes` — title, content, note_type, summary, links.
- `decisions` — title, context, decision_text, rationale, options_considered, linked_project_id.
- `attachments` — file, mime, storage_path, extracted_text, parse_status.

**Work / projects**
- `projects` — name, description, status, priority, start/due, next_action, blocker_summary.
- `project_updates` — project_id, text, type.
- `incidents` — title, description, issue_type, severity, status, owner, vendor_id, follow_up_date.
- `vendors` — name, contact_name/email/phone, notes.
- `procurement_items` — item, status, vendor_id, amount, dates.
- `renewals` — name, category, renewal_date, amount, linked_vendor_id, linked_project_id.
- `assets` — name, type, owner, metadata_json.

## C. Inbox

- `email_accounts` — email_address, provider, purpose (work/finance/personal), is_active.
- `emails` — account_id, external_email_id, thread_id, subject, from_*, to_json, cc_json, received_at, body_text, body_html, category, importance, requires_action, finance_related, linked_bank_id, linked_card_id, linked_project_id, ai_summary.
- `email_attachments` — email_id, file_name, mime, storage_path, extracted_text, attachment_type, parse_status.
- `email_actions` — email_id, action, actor (user/jarvis), meta_json.

## D. Finance

**Structure**
- `banks` — name, notes.
- `financial_accounts` — bank_id, nickname, account_type, masked_number, statement_cycle_day, source_email, notes.
- `credit_cards` — bank_id, card_name, masked_number, billing_day, due_day, limit_amount, statement_password_rule_id, autopay, notes.
- `loans` — lender, type, principal, rate, EMI, tenure_months, start_date, outstanding, next_due_date, linked_account_id.
- `financial_goals` — title, type, target_amount, target_date, current_amount, linked_account_id.
- `subscriptions` — name, category, amount, billing_cycle, next_due_date, linked_account_id, linked_card_id.

**Ingestion & reconciliation**
- `finance_email_rules` — bank_id, card_id, loan_id, email_account_id, sender_pattern, subject_pattern, attachment_name_pattern, statement_password_rule_json, is_active.
- `statements` — statement_type, account/card/loan_id, period_start/end, statement_date, source_email_id, file_path, parse_status, transactions_found, reconciliation_status.
- `transactions` — account/card/loan_id, txn_date, amount, txn_type, merchant, description, category, source, source_email_id, source_statement_id, reference_number, is_reconciled, confidence_score, duplicate_group_id.
- `reconciliation_matches` — statement_id, statement_transaction_hash, matched_transaction_id, confidence_score, status.
- `category_rules` — pattern, category, priority, learned_from_correction (bool).

## E. Automation / logs

- `automations` — name, type, config_json, is_active, last_run_at, next_run_at.
- `automation_runs` — automation_id, status, result_json.
- `jarvis_actions` — action_type, command_text, target_module, status, input_json, output_json.

## Relationships (highlights)

- `emails.linked_bank_id` / `linked_card_id` / `linked_project_id` — cross-links from inbox.
- `transactions.source_email_id` / `source_statement_id` — provenance for every txn.
- `reconciliation_matches` — many-to-one bridge from a statement row to a canonical transaction.
- `entity_links` — generic bag for anything JARVIS wants to relate.
- `notes` / `decisions` / `tasks` all link to `projects` and to `entities`.

## Enums to define in Step 2

- task_status, task_priority, note_type, project_status, project_priority
- txn_type, txn_source, statement_type, parse_status, reconciliation_status
- email_category, email_purpose, automation_type, jarvis_action_status
