-- No achieved/achieved_at column: "achieved" is computed client-side as
-- goal.current_amount >= milestone.target_amount, so there's exactly one
-- source of truth for progress rather than two that can disagree.

CREATE TABLE IF NOT EXISTS public.goal_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id uuid NOT NULL REFERENCES public.financial_goals(id) ON DELETE CASCADE,
  title text NOT NULL,
  target_amount numeric(14,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE
);

ALTER TABLE public.goal_milestones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner rw" ON public.goal_milestones FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON public.goal_milestones FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.goal_milestones TO authenticated;
GRANT ALL ON public.goal_milestones TO service_role;

CREATE INDEX IF NOT EXISTS goal_milestones_goal_idx
  ON public.goal_milestones(goal_id, target_amount);
