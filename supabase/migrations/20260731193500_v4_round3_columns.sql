-- Round 3 v4 inputs that had no home in market_stock_scores. Without these the
-- aggregates pass cannot rebuild them and the factors they feed stay null:
--   * EMA cross ages  -> setups.cross_20_50 / cross_50_200 (25% of the bucket)
--   * base dry-up     -> volume.vol_dryup measured before the breakout bar
alter table public.market_stock_scores
  add column if not exists ema_cross_20_50_days integer,
  add column if not exists ema_cross_50_200_days integer,
  add column if not exists vol_dryup_ratio_base numeric;

comment on column public.market_stock_scores.ema_cross_20_50_days is
  'Sessions since EMA20 crossed above EMA50. 0 = today, -1 = currently below (real zero), null = unknown.';
comment on column public.market_stock_scores.ema_cross_50_200_days is
  'Sessions since EMA50 crossed above EMA200. Same encoding as ema_cross_20_50_days.';
comment on column public.market_stock_scores.vol_dryup_ratio_base is
  '5D/20D average volume measured on the base window (ending at the last pre-breakout bar).';
