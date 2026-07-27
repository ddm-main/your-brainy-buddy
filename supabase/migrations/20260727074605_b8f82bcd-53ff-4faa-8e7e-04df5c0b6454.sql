CREATE TABLE public.market_order_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  broker_order_id text,
  broker_status text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX market_order_intents_user_created_idx ON public.market_order_intents (user_id, created_at DESC);

GRANT SELECT ON public.market_order_intents TO authenticated;
GRANT ALL ON public.market_order_intents TO service_role;

ALTER TABLE public.market_order_intents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own intents read" ON public.market_order_intents
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER market_order_intents_updated_at
  BEFORE UPDATE ON public.market_order_intents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();