-- 1) market_funds snapshot table
CREATE TABLE IF NOT EXISTS public.market_funds (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  net_cash numeric,
  available_margin numeric,
  used_margin numeric,
  collateral numeric,
  payin_amount numeric,
  payload jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_funds TO authenticated;
GRANT ALL ON public.market_funds TO service_role;

ALTER TABLE public.market_funds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own funds snapshot"
  ON public.market_funds
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_market_funds_updated_at
  BEFORE UPDATE ON public.market_funds
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2) Schedule nightly AI-recommend cron if missing (alerts-eval already scheduled)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'market-ai-recommend-nightly') THEN
    PERFORM cron.schedule(
      'market-ai-recommend-nightly',
      '30 20 * * *',
      $cron$ SELECT public.market_cron_call('market-ai-recommend'); $cron$
    );
  END IF;
END $$;
