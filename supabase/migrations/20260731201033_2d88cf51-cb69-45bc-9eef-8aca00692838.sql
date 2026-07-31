DO $$
BEGIN
  -- Guarded so this migration is a no-op on a database where the market
  -- scores table has not been created yet, and applies cleanly where it has.
  IF to_regclass('public.market_stock_scores') IS NOT NULL THEN
    ALTER TABLE public.market_stock_scores
      ADD COLUMN IF NOT EXISTS breakout_state_days integer;

    COMMENT ON COLUMN public.market_stock_scores.breakout_state_days IS
      'Sessions since the current breakout_state began. 0 = today. Populated for both fresh and failed states, unlike breakout_freshness_days which is only set while a breakout is alive.';
  END IF;
END $$;