-- market-sync-holdings/market-sync-positions previously did a plain
-- read-then-insert-or-update with no DB-level uniqueness backing it —
-- concurrent sync calls (auto-refresh racing a manual "Sync" click) could
-- both miss each other's in-flight insert and create duplicate rows that
-- double-count portfolio value. Scoped to broker-synced rows only: manual
-- holdings/positions intentionally allow multiple rows per symbol (separate
-- lots at different buy dates), so the constraint must not apply to them.
CREATE UNIQUE INDEX idx_market_holdings_broker_unique
  ON public.market_holdings (user_id, symbol, exchange)
  WHERE source = 'kotak_sync';

CREATE UNIQUE INDEX idx_market_positions_broker_unique
  ON public.market_positions (user_id, symbol, exchange, side)
  WHERE is_broker_synced = true AND closed_at IS NULL;
