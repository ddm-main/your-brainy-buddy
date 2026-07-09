
-- =====================================================================
-- JARVIS v1 schema — single-user personal OS (no auth)
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- shared updated_at trigger fn ----------
create or replace function public.jarvis_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- enums ----------
do $$ begin
  create type public.task_status as enum ('todo','doing','waiting','done','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.task_priority as enum ('low','normal','high','urgent');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.note_type as enum ('general','project','meeting','sop','decision','reference','personal','finance');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.project_status as enum ('active','blocked','done','archived','paused');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.txn_type as enum ('debit','credit');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.txn_source as enum ('manual','email','statement','import','api');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.statement_type as enum ('bank','credit_card','loan');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.parse_status as enum ('pending','ok','failed','skipped');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.reconciliation_status as enum ('pending','matched','partial','conflict','reviewed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.email_category as enum ('important','needs_reply','follow_up','finance','work','personal','other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.email_purpose as enum ('work','finance','personal','other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.automation_type as enum ('finance_scan','inbox_scan','daily_brief','weekly_review','custom');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.jarvis_action_status as enum ('pending','running','success','error','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.entity_type as enum ('person','vendor','bank','project','tool','place','other');
exception when duplicate_object then null; end $$;

-- ---------- helper: permissive RLS for single-user prototype ----------
-- Called after each create table to avoid SQL duplication.
create or replace function public._jarvis_apply_permissive_rls(tname text)
returns void
language plpgsql
as $$
begin
  execute format('grant select, insert, update, delete on public.%I to anon, authenticated;', tname);
  execute format('grant all on public.%I to service_role;', tname);
  execute format('alter table public.%I enable row level security;', tname);
  execute format($p$create policy "jarvis_all_%s" on public.%I for all to anon, authenticated using (true) with check (true);$p$, tname, tname);
end;
$$;

-- =====================================================================
-- CORE
-- =====================================================================

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  full_name text,
  timezone text default 'Asia/Kolkata',
  currency text default 'INR',
  prefs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('profiles');
create trigger t_profiles_touch before update on public.profiles for each row execute function public.jarvis_touch_updated_at();

create table public.app_settings (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  value_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('app_settings');
create trigger t_app_settings_touch before update on public.app_settings for each row execute function public.jarvis_touch_updated_at();

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  color text,
  kind text,
  created_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('tags');

create table public.entities (
  id uuid primary key default gen_random_uuid(),
  type public.entity_type not null,
  name text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index entities_type_idx on public.entities(type);
create index entities_name_idx on public.entities(name);
select public._jarvis_apply_permissive_rls('entities');
create trigger t_entities_touch before update on public.entities for each row execute function public.jarvis_touch_updated_at();

create table public.entity_links (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  target_type text not null,
  target_id uuid not null,
  created_at timestamptz not null default now()
);
create index entity_links_entity_idx on public.entity_links(entity_id);
create index entity_links_target_idx on public.entity_links(target_type, target_id);
select public._jarvis_apply_permissive_rls('entity_links');

-- =====================================================================
-- WORK / PROJECTS (before tasks so FKs resolve)
-- =====================================================================

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  slug text unique,
  name text not null,
  description text,
  status public.project_status not null default 'active',
  priority public.task_priority not null default 'normal',
  start_date date,
  due_date date,
  next_action text,
  blocker_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('projects');
create trigger t_projects_touch before update on public.projects for each row execute function public.jarvis_touch_updated_at();

create table public.project_updates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  update_text text not null,
  update_type text,
  created_at timestamptz not null default now()
);
create index project_updates_project_idx on public.project_updates(project_id, created_at desc);
select public._jarvis_apply_permissive_rls('project_updates');

create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_name text,
  contact_email text,
  contact_phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('vendors');
create trigger t_vendors_touch before update on public.vendors for each row execute function public.jarvis_touch_updated_at();

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  issue_type text,
  severity text,
  status text not null default 'open',
  owner_name text,
  vendor_id uuid references public.vendors(id) on delete set null,
  follow_up_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('incidents');
create trigger t_incidents_touch before update on public.incidents for each row execute function public.jarvis_touch_updated_at();

create table public.procurement_items (
  id uuid primary key default gen_random_uuid(),
  item text not null,
  status text not null default 'requested',
  vendor_id uuid references public.vendors(id) on delete set null,
  amount numeric(14,2),
  requested_on date default current_date,
  expected_on date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('procurement_items');
create trigger t_procurement_touch before update on public.procurement_items for each row execute function public.jarvis_touch_updated_at();

create table public.renewals (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text,
  renewal_date date,
  amount numeric(14,2),
  linked_vendor_id uuid references public.vendors(id) on delete set null,
  linked_project_id uuid references public.projects(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('renewals');
create trigger t_renewals_touch before update on public.renewals for each row execute function public.jarvis_touch_updated_at();

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  asset_type text,
  owner text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('assets');
create trigger t_assets_touch before update on public.assets for each row execute function public.jarvis_touch_updated_at();

-- =====================================================================
-- FINANCE STRUCTURE (before tasks/inbox so FKs resolve)
-- =====================================================================

create table public.banks (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  notes text,
  created_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('banks');

create table public.financial_accounts (
  id uuid primary key default gen_random_uuid(),
  bank_id uuid references public.banks(id) on delete set null,
  nickname text not null,
  account_type text,
  masked_number text,
  statement_cycle_day int,
  source_email text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('financial_accounts');
create trigger t_financial_accounts_touch before update on public.financial_accounts for each row execute function public.jarvis_touch_updated_at();

create table public.credit_cards (
  id uuid primary key default gen_random_uuid(),
  bank_id uuid references public.banks(id) on delete set null,
  card_name text not null,
  masked_number text,
  billing_day int,
  due_day int,
  limit_amount numeric(14,2),
  autopay boolean not null default false,
  statement_password_rule jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('credit_cards');
create trigger t_credit_cards_touch before update on public.credit_cards for each row execute function public.jarvis_touch_updated_at();

create table public.loans (
  id uuid primary key default gen_random_uuid(),
  lender_name text not null,
  loan_type text,
  principal_amount numeric(14,2),
  interest_rate numeric(6,3),
  emi_amount numeric(14,2),
  tenure_months int,
  start_date date,
  outstanding_amount numeric(14,2),
  next_due_date date,
  linked_account_id uuid references public.financial_accounts(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('loans');
create trigger t_loans_touch before update on public.loans for each row execute function public.jarvis_touch_updated_at();

create table public.financial_goals (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  goal_type text,
  target_amount numeric(14,2),
  target_date date,
  current_amount numeric(14,2) not null default 0,
  linked_account_id uuid references public.financial_accounts(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('financial_goals');
create trigger t_financial_goals_touch before update on public.financial_goals for each row execute function public.jarvis_touch_updated_at();

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text,
  amount numeric(14,2),
  billing_cycle text,
  next_due_date date,
  linked_account_id uuid references public.financial_accounts(id) on delete set null,
  linked_card_id uuid references public.credit_cards(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('subscriptions');
create trigger t_subscriptions_touch before update on public.subscriptions for each row execute function public.jarvis_touch_updated_at();

-- =====================================================================
-- INBOX
-- =====================================================================

create table public.email_accounts (
  id uuid primary key default gen_random_uuid(),
  email_address text unique not null,
  provider text,
  purpose public.email_purpose not null default 'other',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('email_accounts');
create trigger t_email_accounts_touch before update on public.email_accounts for each row execute function public.jarvis_touch_updated_at();

create table public.emails (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.email_accounts(id) on delete set null,
  external_email_id text,
  thread_id text,
  subject text,
  from_name text,
  from_email text,
  to_json jsonb,
  cc_json jsonb,
  received_at timestamptz,
  body_text text,
  body_html text,
  category public.email_category,
  importance int,
  requires_action boolean not null default false,
  finance_related boolean not null default false,
  linked_bank_id uuid references public.banks(id) on delete set null,
  linked_card_id uuid references public.credit_cards(id) on delete set null,
  linked_project_id uuid references public.projects(id) on delete set null,
  ai_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, external_email_id)
);
create index emails_received_idx on public.emails(received_at desc);
create index emails_category_idx on public.emails(category);
select public._jarvis_apply_permissive_rls('emails');
create trigger t_emails_touch before update on public.emails for each row execute function public.jarvis_touch_updated_at();

create table public.email_attachments (
  id uuid primary key default gen_random_uuid(),
  email_id uuid not null references public.emails(id) on delete cascade,
  file_name text,
  mime_type text,
  storage_path text,
  extracted_text text,
  attachment_type text,
  parse_status public.parse_status not null default 'pending',
  created_at timestamptz not null default now()
);
create index email_attachments_email_idx on public.email_attachments(email_id);
select public._jarvis_apply_permissive_rls('email_attachments');

create table public.email_actions (
  id uuid primary key default gen_random_uuid(),
  email_id uuid not null references public.emails(id) on delete cascade,
  action text not null,
  actor text not null default 'user',
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('email_actions');

-- =====================================================================
-- PRODUCTIVITY / MEMORY  (needs projects, emails, accounts, goals)
-- =====================================================================

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  status public.task_status not null default 'todo',
  priority public.task_priority not null default 'normal',
  due_at timestamptz,
  reminder_at timestamptz,
  source text,
  category text,
  owner text,
  focus boolean not null default false,
  linked_project_id uuid references public.projects(id) on delete set null,
  linked_email_id uuid references public.emails(id) on delete set null,
  linked_account_id uuid references public.financial_accounts(id) on delete set null,
  linked_goal_id uuid references public.financial_goals(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_status_idx on public.tasks(status);
create index tasks_due_idx on public.tasks(due_at);
create index tasks_focus_idx on public.tasks(focus) where focus = true;
select public._jarvis_apply_permissive_rls('tasks');
create trigger t_tasks_touch before update on public.tasks for each row execute function public.jarvis_touch_updated_at();

create table public.task_recurrence_rules (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  recurrence_type text not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('task_recurrence_rules');

create table public.task_activity (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  action text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index task_activity_task_idx on public.task_activity(task_id, created_at desc);
select public._jarvis_apply_permissive_rls('task_activity');

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text,
  note_type public.note_type not null default 'general',
  summary text,
  linked_project_id uuid references public.projects(id) on delete set null,
  linked_entity_type text,
  linked_entity_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index notes_type_idx on public.notes(note_type);
create index notes_project_idx on public.notes(linked_project_id);
select public._jarvis_apply_permissive_rls('notes');
create trigger t_notes_touch before update on public.notes for each row execute function public.jarvis_touch_updated_at();

create table public.decisions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  context text,
  options_considered text,
  decision_text text not null,
  rationale text,
  linked_project_id uuid references public.projects(id) on delete set null,
  decided_on date not null default current_date,
  created_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('decisions');

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  mime_type text,
  storage_path text,
  extracted_text text,
  parse_status public.parse_status not null default 'pending',
  linked_type text,
  linked_id uuid,
  created_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('attachments');

-- =====================================================================
-- FINANCE INGESTION
-- =====================================================================

create table public.finance_email_rules (
  id uuid primary key default gen_random_uuid(),
  bank_id uuid references public.banks(id) on delete set null,
  credit_card_id uuid references public.credit_cards(id) on delete set null,
  loan_id uuid references public.loans(id) on delete set null,
  email_account_id uuid references public.email_accounts(id) on delete set null,
  sender_pattern text,
  subject_pattern text,
  attachment_name_pattern text,
  statement_password_rule jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('finance_email_rules');
create trigger t_finance_email_rules_touch before update on public.finance_email_rules for each row execute function public.jarvis_touch_updated_at();

create table public.statements (
  id uuid primary key default gen_random_uuid(),
  statement_type public.statement_type not null,
  financial_account_id uuid references public.financial_accounts(id) on delete set null,
  credit_card_id uuid references public.credit_cards(id) on delete set null,
  loan_id uuid references public.loans(id) on delete set null,
  bank_id uuid references public.banks(id) on delete set null,
  statement_start_date date,
  statement_end_date date,
  statement_date date,
  source_email_id uuid references public.emails(id) on delete set null,
  file_path text,
  parse_status public.parse_status not null default 'pending',
  transactions_found int not null default 0,
  reconciliation_status public.reconciliation_status not null default 'pending',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index statements_type_idx on public.statements(statement_type);
create index statements_date_idx on public.statements(statement_date desc);
select public._jarvis_apply_permissive_rls('statements');
create trigger t_statements_touch before update on public.statements for each row execute function public.jarvis_touch_updated_at();

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  financial_account_id uuid references public.financial_accounts(id) on delete set null,
  credit_card_id uuid references public.credit_cards(id) on delete set null,
  loan_id uuid references public.loans(id) on delete set null,
  txn_date date not null,
  amount numeric(14,2) not null,
  txn_type public.txn_type not null,
  merchant text,
  description text,
  category text,
  source public.txn_source not null default 'manual',
  source_email_id uuid references public.emails(id) on delete set null,
  source_statement_id uuid references public.statements(id) on delete set null,
  reference_number text,
  is_reconciled boolean not null default false,
  confidence_score numeric(4,3),
  duplicate_group_id uuid,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index transactions_date_idx on public.transactions(txn_date desc);
create index transactions_account_idx on public.transactions(financial_account_id);
create index transactions_card_idx on public.transactions(credit_card_id);
create index transactions_dup_idx on public.transactions(duplicate_group_id);
select public._jarvis_apply_permissive_rls('transactions');
create trigger t_transactions_touch before update on public.transactions for each row execute function public.jarvis_touch_updated_at();

create table public.reconciliation_matches (
  id uuid primary key default gen_random_uuid(),
  statement_id uuid not null references public.statements(id) on delete cascade,
  statement_transaction_hash text,
  matched_transaction_id uuid references public.transactions(id) on delete set null,
  confidence_score numeric(4,3),
  status public.reconciliation_status not null default 'pending',
  notes text,
  created_at timestamptz not null default now()
);
create index reconciliation_stmt_idx on public.reconciliation_matches(statement_id);
select public._jarvis_apply_permissive_rls('reconciliation_matches');

create table public.category_rules (
  id uuid primary key default gen_random_uuid(),
  pattern text not null,
  category text not null,
  priority int not null default 100,
  learned_from_correction boolean not null default false,
  created_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('category_rules');

-- =====================================================================
-- AUTOMATION / LOGS / REMINDERS
-- =====================================================================

create table public.automations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  automation_type public.automation_type not null,
  config jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select public._jarvis_apply_permissive_rls('automations');
create trigger t_automations_touch before update on public.automations for each row execute function public.jarvis_touch_updated_at();

create table public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references public.automations(id) on delete cascade,
  status public.jarvis_action_status not null default 'pending',
  result jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index automation_runs_auto_idx on public.automation_runs(automation_id, started_at desc);
select public._jarvis_apply_permissive_rls('automation_runs');

create table public.jarvis_actions (
  id uuid primary key default gen_random_uuid(),
  action_type text not null,
  command_text text,
  target_module text,
  status public.jarvis_action_status not null default 'pending',
  input jsonb,
  output jsonb,
  created_at timestamptz not null default now()
);
create index jarvis_actions_created_idx on public.jarvis_actions(created_at desc);
select public._jarvis_apply_permissive_rls('jarvis_actions');

create table public.jarvis_reminders (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  fire_at timestamptz not null,
  fired boolean not null default false,
  linked_task_id uuid references public.tasks(id) on delete set null,
  created_at timestamptz not null default now()
);
create index jarvis_reminders_due_idx on public.jarvis_reminders(fire_at) where fired = false;
select public._jarvis_apply_permissive_rls('jarvis_reminders');

-- ---------- cleanup helper ----------
drop function public._jarvis_apply_permissive_rls(text);
