-- 1) Holdings: settled / T1 / pledged breakdown (nullable — existing rows unaffected)
ALTER TABLE public.market_holdings
  ADD COLUMN IF NOT EXISTS settled_qty numeric,
  ADD COLUMN IF NOT EXISTS t1_qty      numeric,
  ADD COLUMN IF NOT EXISTS pledged_qty numeric;

-- 2) Positions: broker-synced flag (referenced by market-sync-positions guard)
ALTER TABLE public.market_positions
  ADD COLUMN IF NOT EXISTS is_broker_synced boolean NOT NULL DEFAULT false;

-- 3) Realized intraday P&L snapshot — one row per (user, day, symbol, exchange)
CREATE TABLE IF NOT EXISTS public.market_realized_pnl_daily (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  day          date NOT NULL,
  symbol       text NOT NULL,
  exchange     text NOT NULL,
  quantity     numeric NOT NULL,
  realized     numeric NOT NULL,
  source       text NOT NULL DEFAULT 'kotak_sync',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, day, symbol, exchange)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_realized_pnl_daily TO authenticated;
GRANT ALL ON public.market_realized_pnl_daily TO service_role;

ALTER TABLE public.market_realized_pnl_daily ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='market_realized_pnl_daily'
      AND policyname='Users manage own realized pnl'
  ) THEN
    CREATE POLICY "Users manage own realized pnl"
      ON public.market_realized_pnl_daily
      FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_market_realized_pnl_daily_updated_at ON public.market_realized_pnl_daily;
CREATE TRIGGER trg_market_realized_pnl_daily_updated_at
  BEFORE UPDATE ON public.market_realized_pnl_daily
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
