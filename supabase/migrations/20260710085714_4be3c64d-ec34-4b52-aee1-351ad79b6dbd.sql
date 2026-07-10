
-- Per-user daily AI usage counters + atomic increment RPC
CREATE TABLE IF NOT EXISTS public.jarvis_usage_daily (
  user_id uuid NOT NULL DEFAULT auth.uid(),
  day date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  requests integer NOT NULL DEFAULT 0,
  tokens bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

GRANT SELECT ON public.jarvis_usage_daily TO authenticated;
GRANT ALL ON public.jarvis_usage_daily TO service_role;

ALTER TABLE public.jarvis_usage_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own_usage_read" ON public.jarvis_usage_daily
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Atomic increment. SECURITY DEFINER + explicit user_id arg; caller (edge fn / service role) trusted.
CREATE OR REPLACE FUNCTION public.increment_jarvis_usage(
  _user_id uuid,
  _requests integer DEFAULT 1,
  _tokens bigint DEFAULT 0
) RETURNS TABLE(requests integer, tokens bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  today date := (now() AT TIME ZONE 'utc')::date;
BEGIN
  INSERT INTO public.jarvis_usage_daily(user_id, day, requests, tokens)
  VALUES (_user_id, today, _requests, _tokens)
  ON CONFLICT (user_id, day) DO UPDATE
    SET requests = public.jarvis_usage_daily.requests + EXCLUDED.requests,
        tokens   = public.jarvis_usage_daily.tokens   + EXCLUDED.tokens,
        updated_at = now()
  RETURNING public.jarvis_usage_daily.requests, public.jarvis_usage_daily.tokens
  INTO requests, tokens;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_jarvis_usage(uuid, integer, bigint) FROM public;
GRANT EXECUTE ON FUNCTION public.increment_jarvis_usage(uuid, integer, bigint) TO service_role;
