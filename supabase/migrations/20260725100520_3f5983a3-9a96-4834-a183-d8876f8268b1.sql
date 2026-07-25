ALTER TABLE public.market_api_settings
  ADD COLUMN IF NOT EXISTS funds_last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS funds_last_error_code text,
  ADD COLUMN IF NOT EXISTS funds_retry_after_at timestamptz;

CREATE TABLE IF NOT EXISTS public.market_provider_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  endpoint text NOT NULL,
  ok boolean NOT NULL,
  latency_ms integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.market_provider_health TO service_role;

ALTER TABLE public.market_provider_health ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_market_provider_health_endpoint_created
  ON public.market_provider_health (endpoint, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_provider_health_provider_created
  ON public.market_provider_health (provider, created_at DESC);