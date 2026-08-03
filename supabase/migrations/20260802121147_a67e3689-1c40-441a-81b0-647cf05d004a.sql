ALTER TABLE public.detection_runs ALTER COLUMN user_id DROP NOT NULL;

CREATE POLICY "admins read system detection_runs"
ON public.detection_runs
FOR SELECT
TO authenticated
USING (user_id IS NULL AND public.has_role(auth.uid(), 'admin'));