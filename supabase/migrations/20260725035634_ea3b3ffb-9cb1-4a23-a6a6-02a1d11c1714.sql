
-- =============================================================================
-- P1 additions: GTT orders table + trailing-stop columns for AutoTrade.
-- =============================================================================

-- 1) market_gtt_orders — Good-Till-Triggered orders that live in our DB and
--    get evaluated by a cron job comparing LTP to the trigger. Kotak Neo has
--    no native GTT so we replicate Zerodha/Streak's behavior locally: once
--    triggered, we place a real order via market-order-place and record the
--    resulting broker_order_id.
CREATE TABLE public.market_gtt_orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL DEFAULT 'NSE',
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  -- 'single' = one trigger price. 'OCO' = one-cancels-other with two
  -- trigger prices (typically a stop-loss below and a target above).
  trigger_type TEXT NOT NULL DEFAULT 'single' CHECK (trigger_type IN ('single','OCO')),
  trigger_price NUMERIC NOT NULL,
  trigger_price_upper NUMERIC, -- OCO upper leg (target)
  order_type TEXT NOT NULL DEFAULT 'LIMIT' CHECK (order_type IN ('MARKET','LIMIT')),
  price NUMERIC, -- limit price when order_type = LIMIT
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  product TEXT NOT NULL DEFAULT 'CNC' CHECK (product IN ('MIS','CNC','NRML')),
  -- 'active' = watching. 'triggered' = fired, order placed. 'cancelled' =
  -- user cancelled. 'expired' = past expires_at without triggering.
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','triggered','cancelled','expired','failed')),
  expires_at TIMESTAMPTZ, -- NULL = GTC (no expiry)
  triggered_at TIMESTAMPTZ,
  triggered_leg TEXT, -- 'lower' or 'upper' for OCO
  broker_order_id TEXT,
  last_error TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX market_gtt_orders_active_idx
  ON public.market_gtt_orders (user_id, status)
  WHERE status = 'active';
CREATE INDEX market_gtt_orders_scan_idx
  ON public.market_gtt_orders (status, symbol, exchange)
  WHERE status = 'active';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_gtt_orders TO authenticated;
GRANT ALL ON public.market_gtt_orders TO service_role;

ALTER TABLE public.market_gtt_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own GTT orders"
  ON public.market_gtt_orders FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_market_gtt_orders_updated_at
  BEFORE UPDATE ON public.market_gtt_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2) Trailing-stop-loss for AutoTrade rules.
--    trail_stop_pct: when set, the effective stop-loss ratchets up as the
--    LTP makes new highs since entry. e.g. 2 means "stop is always 2%
--    below the best LTP seen since entry"; overrides the fixed
--    stop_loss_pct once the trail is tighter than the fixed stop.
ALTER TABLE public.market_autotrade_rules
  ADD COLUMN IF NOT EXISTS trail_stop_pct NUMERIC;

-- 3) High-water-mark for each open AutoTrade entry — updated per eval tick
--    to the max LTP seen since entry, so trail_stop_pct can compute a
--    ratcheting stop without re-reading candle history every tick.
ALTER TABLE public.market_autotrade_orders
  ADD COLUMN IF NOT EXISTS high_water_ltp NUMERIC;
