-- =========================================================================
-- AutoTrade hardening: a lease column to stop overlapping cron ticks from
-- double-firing the same rule. Everything else in this pass (broker-position
-- reconciliation, circuit-breaker exit protection, per-symbol dedup) is
-- application logic in market-autotrade-eval/market-autotrade-action and
-- needs no further schema change — filled_price/filled_at already existed
-- but were never written; the reconciliation approach nets against the
-- broker's live position book instead (unambiguous, no need to parse
-- Kotak's order-status strings), so no filled_quantity column is needed.
-- =========================================================================

ALTER TABLE public.market_autotrade_settings
  ADD COLUMN IF NOT EXISTS eval_lock_at timestamptz;
