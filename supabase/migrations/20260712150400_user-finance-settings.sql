-- Single-row-per-user settings surface. Currently holds just the
-- investments asset-type visibility toggle (mutual_fund/stock shown by
-- default; ETF/Gold/PPF/EPF/NPS/FD/Bonds/RealEstate/Crypto hidden until
-- explicitly enabled) — a full Settings route isn't justified for one
-- toggle, so this lives inline in the Investments page.

CREATE TABLE IF NOT EXISTS public.user_finance_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enabled_asset_types text[] NOT NULL DEFAULT ARRAY['mutual_fund','stock'],
  updated_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  UNIQUE (user_id)
);

ALTER TABLE public.user_finance_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner rw" ON public.user_finance_settings FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON public.user_finance_settings FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_finance_settings TO authenticated;
GRANT ALL ON public.user_finance_settings TO service_role;
