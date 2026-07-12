-- Give each AI endpoint its own daily budget instead of sharing jarvis-chat's.
-- Continuous STT dictation (src/lib/stt.ts polls jarvis-transcribe roughly
-- every 2.5s) would otherwise exhaust a shared (user_id, day) counter in one
-- voice session and start blocking legitimate jarvis-chat requests too.
-- Additive/backward-compatible: increment_jarvis_usage's new _endpoint
-- parameter defaults to 'chat', so jarvis-chat's existing 3-arg RPC call
-- (PostgREST calls by name) keeps accumulating into the same bucket as
-- before, unchanged.

ALTER TABLE public.jarvis_usage_daily
  ADD COLUMN IF NOT EXISTS endpoint text NOT NULL DEFAULT 'chat';

ALTER TABLE public.jarvis_usage_daily
  ADD CONSTRAINT jarvis_usage_daily_endpoint_check
  CHECK (endpoint IN ('chat','tts','transcribe','vision','vision_upload'));

-- Original table was created with an unnamed inline PRIMARY KEY (user_id,
-- day), so Postgres's default naming convention applies here.
ALTER TABLE public.jarvis_usage_daily DROP CONSTRAINT IF EXISTS jarvis_usage_daily_pkey;
ALTER TABLE public.jarvis_usage_daily ADD PRIMARY KEY (user_id, day, endpoint);

-- Must DROP first: CREATE OR REPLACE with a different parameter list creates
-- an overload rather than replacing it, which would make PostgREST's 3-arg
-- RPC call (jarvis-chat's existing call site) ambiguous between the old and
-- new signatures.
DROP FUNCTION IF EXISTS public.increment_jarvis_usage(uuid, integer, bigint);

CREATE FUNCTION public.increment_jarvis_usage(
  _user_id uuid,
  _requests integer DEFAULT 1,
  _tokens bigint DEFAULT 0,
  _endpoint text DEFAULT 'chat'
) RETURNS TABLE(requests integer, tokens bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  today date := (now() AT TIME ZONE 'utc')::date;
BEGIN
  INSERT INTO public.jarvis_usage_daily(user_id, day, endpoint, requests, tokens)
  VALUES (_user_id, today, _endpoint, _requests, _tokens)
  ON CONFLICT (user_id, day, endpoint) DO UPDATE
    SET requests = public.jarvis_usage_daily.requests + EXCLUDED.requests,
        tokens   = public.jarvis_usage_daily.tokens   + EXCLUDED.tokens,
        updated_at = now()
  RETURNING public.jarvis_usage_daily.requests, public.jarvis_usage_daily.tokens
  INTO requests, tokens;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_jarvis_usage(uuid, integer, bigint, text) FROM public;
GRANT EXECUTE ON FUNCTION public.increment_jarvis_usage(uuid, integer, bigint, text) TO service_role;
