-- v4 round-trip fidelity: the aggregates pass re-scores from stored columns,
-- so every field breakoutScoreV4 reads must survive the DB round-trip.
ALTER TABLE public.market_stock_scores
  ADD COLUMN IF NOT EXISTS support_fallback boolean,
  ADD COLUMN IF NOT EXISTS resistance_fallback boolean,
  ADD COLUMN IF NOT EXISTS resistance_above numeric,
  ADD COLUMN IF NOT EXISTS breakout_state text,
  ADD COLUMN IF NOT EXISTS breakout_level_cleared numeric,
  ADD COLUMN IF NOT EXISTS rolling_high_20_touches integer,
  ADD COLUMN IF NOT EXISTS rolling_high_20_touch_quality numeric,
  ADD COLUMN IF NOT EXISTS macd_hist_rising boolean,
  ADD COLUMN IF NOT EXISTS atr_contracting boolean,
  ADD COLUMN IF NOT EXISTS weekly_bars integer;
