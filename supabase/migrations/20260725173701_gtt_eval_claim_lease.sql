-- market-gtt-eval had no equivalent of market-autotrade-eval's per-row
-- claim lease: two overlapping cron invocations (a slow tick still placing
-- an order when the next minute's cron fires, or a duplicate webhook call)
-- could both read the same 'active' GTT row and both place a real order for
-- it before either write landed. eval_claimed_at lets market-gtt-eval claim
-- a row atomically via a conditional UPDATE before firing, the same pattern
-- already proven by market_autotrade_settings.eval_lock_at.
ALTER TABLE public.market_gtt_orders ADD COLUMN eval_claimed_at timestamptz;
