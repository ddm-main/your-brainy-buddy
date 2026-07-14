
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='transactions' AND column_name='detected_kind') THEN
    ALTER TABLE public.transactions ADD COLUMN detected_kind text
      CHECK (detected_kind IN ('salary','sip','emi','investment','insurance','cc_payment','dividend','interest','refund','recurring','transfer'));
    CREATE INDEX transactions_detected_kind_idx ON public.transactions(user_id, detected_kind) WHERE detected_kind IS NOT NULL;
  END IF;
END $$;

ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS auto_detected boolean NOT NULL DEFAULT false;

ALTER TABLE public.financial_goals
  ADD COLUMN IF NOT EXISTS funding_source_account_id uuid REFERENCES public.financial_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retirement_target numeric,
  ADD COLUMN IF NOT EXISTS emergency_target_months integer;

CREATE TABLE IF NOT EXISTS public.detection_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  scanned integer NOT NULL DEFAULT 0,
  flagged integer NOT NULL DEFAULT 0,
  duration_ms integer,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.detection_runs TO authenticated;
GRANT ALL ON public.detection_runs TO service_role;
ALTER TABLE public.detection_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner rw detection_runs" ON public.detection_runs FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS detection_runs_user_idx ON public.detection_runs(user_id, created_at DESC);
CREATE TRIGGER trg_detection_runs_updated BEFORE UPDATE ON public.detection_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
