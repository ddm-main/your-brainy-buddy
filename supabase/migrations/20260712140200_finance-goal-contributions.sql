-- Contribution history for goals — today a "+amount" button just overwrites
-- financial_goals.current_amount with no log (unlike loans, which already
-- have real payment history). This adds the log plus an AFTER INSERT
-- trigger that bumps current_amount atomically in the same transaction,
-- rather than two sequential client-side writes that could drift if the
-- second one fails.

CREATE TABLE IF NOT EXISTS public.goal_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id uuid NOT NULL REFERENCES public.financial_goals(id) ON DELETE CASCADE,
  amount numeric(14,2) NOT NULL,
  contributed_at date NOT NULL DEFAULT current_date,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE
);

ALTER TABLE public.goal_contributions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner rw" ON public.goal_contributions FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON public.goal_contributions FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.goal_contributions TO authenticated;
GRANT ALL ON public.goal_contributions TO service_role;

CREATE INDEX IF NOT EXISTS goal_contributions_goal_idx
  ON public.goal_contributions(goal_id, contributed_at DESC);

CREATE OR REPLACE FUNCTION public.bump_goal_current_amount()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.financial_goals
    SET current_amount = COALESCE(current_amount, 0) + NEW.amount
    WHERE id = NEW.goal_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_goal_contribution_bump
  AFTER INSERT ON public.goal_contributions
  FOR EACH ROW EXECUTE FUNCTION public.bump_goal_current_amount();
