
-- ============ ENUMS ============
DO $$ BEGIN
  CREATE TYPE public.task_status AS ENUM ('todo','doing','waiting','done','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.task_priority AS ENUM ('low','normal','high','urgent');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.note_type AS ENUM ('general','project','meeting','sop','decision','reference','personal','finance');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.project_status AS ENUM ('active','on_hold','done','archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.project_priority AS ENUM ('low','normal','high','urgent');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.txn_type AS ENUM ('debit','credit','transfer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.txn_source AS ENUM ('manual','email','statement','import');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.statement_type AS ENUM ('account','card','loan');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.parse_status AS ENUM ('pending','parsed','failed','skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.reconciliation_status AS ENUM ('unreconciled','partial','reconciled','review');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.email_category AS ENUM ('important','needs_reply','follow_up','finance','work','personal','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.email_purpose AS ENUM ('work','finance','personal','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.jarvis_action_status AS ENUM ('pending','success','error');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============ Reshape existing projects ============
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS priority public.project_priority NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS next_action text,
  ADD COLUMN IF NOT EXISTS blocker_summary text,
  ADD COLUMN IF NOT EXISTS start_date date,
  ADD COLUMN IF NOT EXISTS due_date date,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

UPDATE public.projects SET name = title WHERE name IS NULL;

-- Replace deny policies with open single-user posture
DROP POLICY IF EXISTS "Deny anon and authenticated" ON public.projects;
CREATE POLICY "single user open" ON public.projects
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO anon, authenticated;
GRANT ALL ON public.projects TO service_role;

DROP POLICY IF EXISTS "Deny anon and authenticated" ON public.next_actions;
CREATE POLICY "single user open" ON public.next_actions
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.next_actions TO anon, authenticated;
GRANT ALL ON public.next_actions TO service_role;

DROP POLICY IF EXISTS "Deny anon and authenticated" ON public.areas;
CREATE POLICY "single user open" ON public.areas
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.areas TO anon, authenticated;
GRANT ALL ON public.areas TO service_role;

DROP POLICY IF EXISTS "Deny anon and authenticated" ON public.daily_logs;
CREATE POLICY "single user open" ON public.daily_logs
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.daily_logs TO anon, authenticated;
GRANT ALL ON public.daily_logs TO service_role;

DROP POLICY IF EXISTS "Deny anon and authenticated" ON public.inbox_items;
CREATE POLICY "single user open" ON public.inbox_items
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbox_items TO anon, authenticated;
GRANT ALL ON public.inbox_items TO service_role;

DROP POLICY IF EXISTS "Deny anon and authenticated" ON public.memories;
CREATE POLICY "single user open" ON public.memories
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memories TO anon, authenticated;
GRANT ALL ON public.memories TO service_role;

-- jarvis_memory + jarvis_reminders had no policies; open them and grant
ALTER TABLE public.jarvis_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.jarvis_memory
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.jarvis_memory TO anon, authenticated;
GRANT ALL ON public.jarvis_memory TO service_role;

ALTER TABLE public.jarvis_reminders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.jarvis_reminders
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.jarvis_reminders TO anon, authenticated;
GRANT ALL ON public.jarvis_reminders TO service_role;

ALTER TABLE public.jarvis_reminders ADD COLUMN IF NOT EXISTS linked_task_id uuid;

-- ============ Tasks ============
CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  status public.task_status NOT NULL DEFAULT 'todo',
  priority public.task_priority NOT NULL DEFAULT 'normal',
  focus boolean NOT NULL DEFAULT false,
  due_at timestamptz,
  reminder_at timestamptz,
  source text,
  category text,
  linked_project_id uuid,
  linked_email_id uuid,
  linked_account_id uuid,
  linked_goal_id uuid,
  owner text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO anon, authenticated;
GRANT ALL ON public.tasks TO service_role;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.tasks FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER trg_tasks_updated BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Notes ============
CREATE TABLE public.notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  content text,
  note_type public.note_type NOT NULL DEFAULT 'general',
  summary text,
  linked_project_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO anon, authenticated;
GRANT ALL ON public.notes TO service_role;
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.notes FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER trg_notes_updated BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Decisions ============
CREATE TABLE public.decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  context text,
  decision_text text NOT NULL,
  rationale text,
  options_considered text,
  linked_project_id uuid,
  decided_on date NOT NULL DEFAULT current_date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.decisions TO anon, authenticated;
GRANT ALL ON public.decisions TO service_role;
ALTER TABLE public.decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.decisions FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER trg_decisions_updated BEFORE UPDATE ON public.decisions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Project updates ============
CREATE TABLE public.project_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  update_text text NOT NULL,
  update_type text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_updates TO anon, authenticated;
GRANT ALL ON public.project_updates TO service_role;
ALTER TABLE public.project_updates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.project_updates FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- ============ Email accounts ============
CREATE TABLE public.email_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_address text NOT NULL UNIQUE,
  provider text,
  purpose public.email_purpose NOT NULL DEFAULT 'other',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_accounts TO anon, authenticated;
GRANT ALL ON public.email_accounts TO service_role;
ALTER TABLE public.email_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.email_accounts FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- ============ Emails ============
CREATE TABLE public.emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES public.email_accounts(id) ON DELETE CASCADE,
  external_email_id text,
  thread_id text,
  subject text,
  from_name text,
  from_address text,
  to_json jsonb,
  cc_json jsonb,
  received_at timestamptz,
  body_text text,
  body_html text,
  category public.email_category,
  importance int,
  requires_action boolean NOT NULL DEFAULT false,
  finance_related boolean NOT NULL DEFAULT false,
  linked_bank_id uuid,
  linked_card_id uuid,
  linked_project_id uuid,
  ai_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.emails TO anon, authenticated;
GRANT ALL ON public.emails TO service_role;
ALTER TABLE public.emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.emails FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER trg_emails_updated BEFORE UPDATE ON public.emails
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Email attachments ============
CREATE TABLE public.email_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id uuid NOT NULL REFERENCES public.emails(id) ON DELETE CASCADE,
  file_name text,
  mime text,
  storage_path text,
  extracted_text text,
  attachment_type text,
  parse_status public.parse_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_attachments TO anon, authenticated;
GRANT ALL ON public.email_attachments TO service_role;
ALTER TABLE public.email_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.email_attachments FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- ============ Email actions ============
CREATE TABLE public.email_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id uuid NOT NULL REFERENCES public.emails(id) ON DELETE CASCADE,
  action text NOT NULL,
  actor text,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_actions TO anon, authenticated;
GRANT ALL ON public.email_actions TO service_role;
ALTER TABLE public.email_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.email_actions FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- ============ Banks ============
CREATE TABLE public.banks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.banks TO anon, authenticated;
GRANT ALL ON public.banks TO service_role;
ALTER TABLE public.banks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.banks FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- ============ Financial accounts ============
CREATE TABLE public.financial_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_id uuid REFERENCES public.banks(id) ON DELETE SET NULL,
  nickname text NOT NULL,
  account_type text,
  masked_number text,
  statement_cycle_day int,
  source_email text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.financial_accounts TO anon, authenticated;
GRANT ALL ON public.financial_accounts TO service_role;
ALTER TABLE public.financial_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.financial_accounts FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER trg_financial_accounts_updated BEFORE UPDATE ON public.financial_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Credit cards ============
CREATE TABLE public.credit_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_id uuid REFERENCES public.banks(id) ON DELETE SET NULL,
  card_name text NOT NULL,
  masked_number text,
  billing_day int,
  due_day int,
  limit_amount numeric,
  statement_password_rule jsonb,
  autopay boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.credit_cards TO anon, authenticated;
GRANT ALL ON public.credit_cards TO service_role;
ALTER TABLE public.credit_cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.credit_cards FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER trg_credit_cards_updated BEFORE UPDATE ON public.credit_cards
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Loans ============
CREATE TABLE public.loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lender_name text NOT NULL,
  loan_type text,
  principal_amount numeric,
  interest_rate numeric,
  emi_amount numeric,
  tenure_months int,
  start_date date,
  outstanding_amount numeric,
  next_due_date date,
  linked_account_id uuid REFERENCES public.financial_accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.loans TO anon, authenticated;
GRANT ALL ON public.loans TO service_role;
ALTER TABLE public.loans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.loans FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER trg_loans_updated BEFORE UPDATE ON public.loans
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Financial goals ============
CREATE TABLE public.financial_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  goal_type text,
  target_amount numeric,
  target_date date,
  current_amount numeric NOT NULL DEFAULT 0,
  linked_account_id uuid REFERENCES public.financial_accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.financial_goals TO anon, authenticated;
GRANT ALL ON public.financial_goals TO service_role;
ALTER TABLE public.financial_goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.financial_goals FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER trg_financial_goals_updated BEFORE UPDATE ON public.financial_goals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Subscriptions ============
CREATE TABLE public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text,
  amount numeric,
  billing_cycle text,
  next_due_date date,
  linked_account_id uuid REFERENCES public.financial_accounts(id) ON DELETE SET NULL,
  linked_card_id uuid REFERENCES public.credit_cards(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subscriptions TO anon, authenticated;
GRANT ALL ON public.subscriptions TO service_role;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.subscriptions FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER trg_subscriptions_updated BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Statements ============
CREATE TABLE public.statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_type public.statement_type NOT NULL,
  financial_account_id uuid REFERENCES public.financial_accounts(id) ON DELETE CASCADE,
  credit_card_id uuid REFERENCES public.credit_cards(id) ON DELETE CASCADE,
  loan_id uuid REFERENCES public.loans(id) ON DELETE CASCADE,
  period_start date,
  period_end date,
  statement_date date,
  source_email_id uuid REFERENCES public.emails(id) ON DELETE SET NULL,
  file_path text,
  parse_status public.parse_status NOT NULL DEFAULT 'pending',
  transactions_found int NOT NULL DEFAULT 0,
  reconciliation_status public.reconciliation_status NOT NULL DEFAULT 'unreconciled',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.statements TO anon, authenticated;
GRANT ALL ON public.statements TO service_role;
ALTER TABLE public.statements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.statements FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER trg_statements_updated BEFORE UPDATE ON public.statements
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Transactions ============
CREATE TABLE public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  txn_date date NOT NULL,
  amount numeric NOT NULL,
  txn_type public.txn_type NOT NULL,
  merchant text,
  description text,
  category text,
  financial_account_id uuid REFERENCES public.financial_accounts(id) ON DELETE SET NULL,
  credit_card_id uuid REFERENCES public.credit_cards(id) ON DELETE SET NULL,
  loan_id uuid REFERENCES public.loans(id) ON DELETE SET NULL,
  source public.txn_source NOT NULL DEFAULT 'manual',
  source_email_id uuid REFERENCES public.emails(id) ON DELETE SET NULL,
  source_statement_id uuid REFERENCES public.statements(id) ON DELETE SET NULL,
  reference_number text,
  is_reconciled boolean NOT NULL DEFAULT false,
  confidence_score numeric,
  duplicate_group_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.transactions TO anon, authenticated;
GRANT ALL ON public.transactions TO service_role;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.transactions FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER trg_transactions_updated BEFORE UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Finance email rules ============
CREATE TABLE public.finance_email_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_id uuid REFERENCES public.banks(id) ON DELETE CASCADE,
  card_id uuid REFERENCES public.credit_cards(id) ON DELETE CASCADE,
  loan_id uuid REFERENCES public.loans(id) ON DELETE CASCADE,
  email_account_id uuid REFERENCES public.email_accounts(id) ON DELETE CASCADE,
  sender_pattern text,
  subject_pattern text,
  attachment_name_pattern text,
  statement_password_rule jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.finance_email_rules TO anon, authenticated;
GRANT ALL ON public.finance_email_rules TO service_role;
ALTER TABLE public.finance_email_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.finance_email_rules FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- ============ Reconciliation matches ============
CREATE TABLE public.reconciliation_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL REFERENCES public.statements(id) ON DELETE CASCADE,
  statement_transaction_hash text,
  matched_transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  confidence_score numeric,
  status public.reconciliation_status NOT NULL DEFAULT 'unreconciled',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reconciliation_matches TO anon, authenticated;
GRANT ALL ON public.reconciliation_matches TO service_role;
ALTER TABLE public.reconciliation_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.reconciliation_matches FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- ============ JARVIS actions log ============
CREATE TABLE public.jarvis_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type text NOT NULL,
  command_text text,
  target_module text,
  status public.jarvis_action_status NOT NULL DEFAULT 'success',
  input jsonb,
  output jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.jarvis_actions TO anon, authenticated;
GRANT ALL ON public.jarvis_actions TO service_role;
ALTER TABLE public.jarvis_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "single user open" ON public.jarvis_actions FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
