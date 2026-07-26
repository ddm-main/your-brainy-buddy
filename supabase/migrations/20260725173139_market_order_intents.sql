-- market_order_intents — idempotency ledger for market-order-place.
-- A row is inserted with status 'pending' before the broker call and
-- updated to 'placed'/'failed' after. The unique (user_id, idempotency_key)
-- constraint lets a client-retried request (network timeout, double-click)
-- be detected and answered with the original result instead of placing a
-- second real order.
CREATE TABLE public.market_order_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  -- 'ambiguous': a 401/403 hit mid-request and whether the broker actually
  -- received the order is unknown (see KotakAmbiguousOrderError). Unlike
  -- 'failed', this status is never auto-reclaimed by a same-key retry.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'placed', 'failed', 'ambiguous')),
  broker_order_id text,
  broker_status text,
  error text,
  request jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX idx_market_order_intents_user ON public.market_order_intents (user_id);
GRANT SELECT ON public.market_order_intents TO authenticated;
GRANT ALL ON public.market_order_intents TO service_role;
ALTER TABLE public.market_order_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own market_order_intents" ON public.market_order_intents
  FOR SELECT USING (auth.uid() = user_id);
CREATE TRIGGER trg_market_order_intents_updated
  BEFORE UPDATE ON public.market_order_intents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
