-- v3 scoring enhancement — additive only. Nothing here touches the existing
-- breakout_score/prebreakout_score columns or their consumers (AutoTrade,
-- alerts, the nightly AI prompt, Dashboard buckets, ScoreBadge's color ramp).
--
-- Note: vwap, supertrend, supertrend_dir, obv, mfi14, bb_percent_b, and
-- pattern_flags columns already exist on market_stock_scores (migration
-- 20260718073259) but have never been written by any function — this
-- migration does not duplicate them, market-pipeline-eod starts populating
-- those existing columns directly.
ALTER TABLE public.market_stock_scores
  ADD COLUMN IF NOT EXISTS weekly_close numeric,
  ADD COLUMN IF NOT EXISTS weekly_ema20 numeric,
  ADD COLUMN IF NOT EXISTS weekly_rsi14 numeric,
  ADD COLUMN IF NOT EXISTS weekly_trend_up boolean,
  ADD COLUMN IF NOT EXISTS weekly_higher_lows boolean,
  ADD COLUMN IF NOT EXISTS intraday_score integer,
  ADD COLUMN IF NOT EXISTS intraday_components jsonb,
  ADD COLUMN IF NOT EXISTS swing_score integer,
  ADD COLUMN IF NOT EXISTS swing_components jsonb,
  ADD COLUMN IF NOT EXISTS is_liquid_tradable boolean,
  ADD COLUMN IF NOT EXISTS liquidity_reasons text[];
