ALTER TABLE public.market_api_settings
  DROP CONSTRAINT IF EXISTS market_api_settings_user_id_active_provider_key;

CREATE UNIQUE INDEX IF NOT EXISTS market_api_settings_user_provider_purpose_uidx
  ON public.market_api_settings (user_id, active_provider, purpose);