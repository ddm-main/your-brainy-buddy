CREATE TABLE public.market_provider_credentials (
  provider text PRIMARY KEY,
  api_key_enc jsonb,
  key_set boolean NOT NULL DEFAULT false,
  key_hint text,
  last_tested_at timestamp with time zone,
  last_test_ok boolean,
  last_test_detail text,
  updated_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT (provider, key_set, key_hint, last_tested_at, last_test_ok, last_test_detail, updated_at) ON public.market_provider_credentials TO authenticated;
GRANT ALL ON public.market_provider_credentials TO service_role;

ALTER TABLE public.market_provider_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read provider credential status"
  ON public.market_provider_credentials
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_market_provider_credentials_updated_at
  BEFORE UPDATE ON public.market_provider_credentials
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();