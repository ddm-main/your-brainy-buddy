-- ============================================================================
-- Finance intelligence layer: manual balance tracking (net worth has no
-- bank-sync API to draw from anywhere in this app, so it's a manually
-- entered field — same spirit as loans.outstanding_amount) and a
-- reconciliation-alerts table for the subscription/loan-vs-transactions
-- matching engine. Same owner-scoped RLS posture as every table since the
-- 2026-07-10 hardening pass (20260710082821_...sql) — see also
-- 20260711172458_finance-statement-pdfs.sql for the precedent this migration
-- follows for ALTER-TABLE-on-an-already-hardened-table.
-- ============================================================================

-- financial_accounts already hardened; no RLS change needed for the new columns.
ALTER TABLE public.financial_accounts
  ADD COLUMN IF NOT EXISTS current_balance numeric,
  ADD COLUMN IF NOT EXISTS current_balance_as_of date;

-- finance_alerts: reconciliation output. entity_type/entity_id is
-- polymorphic (subscriptions or loans) rather than two nullable FK columns,
-- mirroring the existing statements.statement_type polymorphism pattern.
CREATE TABLE IF NOT EXISTS public.finance_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('missing_charge','amount_mismatch')),
  entity_type text NOT NULL CHECK (entity_type IN ('subscription','loan')),
  entity_id uuid NOT NULL,
  expected_amount numeric,
  actual_amount numeric,
  expected_date date NOT NULL,
  message text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','resolved')),
  matched_transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Idempotency key reconciliation.ts reasons about: one alert per
  -- (entity, expected charge date), also guards concurrent double-runs.
  UNIQUE (user_id, entity_type, entity_id, expected_date)
);

ALTER TABLE public.finance_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner rw" ON public.finance_alerts FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON public.finance_alerts FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.finance_alerts TO authenticated;
GRANT ALL ON public.finance_alerts TO service_role;

CREATE INDEX IF NOT EXISTS finance_alerts_open_idx
  ON public.finance_alerts(entity_type, entity_id) WHERE status = 'open';

CREATE TRIGGER trg_finance_alerts_updated BEFORE UPDATE ON public.finance_alerts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Perf: net-worth/utilization computation reads "latest statement per card"
-- on every Finance Overview load.
CREATE INDEX IF NOT EXISTS statements_card_date_idx
  ON public.statements(credit_card_id, statement_date DESC);
