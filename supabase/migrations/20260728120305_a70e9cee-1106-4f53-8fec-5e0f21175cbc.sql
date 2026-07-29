ALTER TABLE public.market_stocks
  ADD COLUMN IF NOT EXISTS shares_sync_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shares_sync_attempted_at timestamptz;

-- Drives candidate selection: least-recently-attempted first, hard-failures last.
CREATE INDEX IF NOT EXISTS market_stocks_shares_sync_idx
  ON public.market_stocks (shares_sync_attempted_at NULLS FIRST, symbol)
  WHERE is_active;

-- Coverage of the reference data the screener's market cap depends on.
CREATE OR REPLACE VIEW public.market_reference_coverage
WITH (security_invoker = on) AS
SELECT
  count(*)                                                   AS active_symbols,
  count(*) FILTER (WHERE total_shares_cr IS NOT NULL)        AS with_shares,
  count(*) FILTER (WHERE market_cap IS NOT NULL)             AS with_market_cap,
  count(*) FILTER (WHERE shares_source = 'yahoo')            AS shares_from_yahoo,
  count(*) FILTER (WHERE shares_source = 'nse')              AS shares_from_nse,
  count(*) FILTER (WHERE shares_source = 'fmp')              AS shares_from_fmp,
  count(*) FILTER (WHERE total_shares_cr IS NULL
                     AND shares_sync_attempts >= 3)          AS shares_hard_failed,
  count(*) FILTER (WHERE total_shares_cr IS NULL
                     AND shares_sync_attempts < 3)           AS shares_pending,
  round(100.0 * count(*) FILTER (WHERE total_shares_cr IS NOT NULL)
        / NULLIF(count(*), 0), 1)                            AS shares_coverage_pct
FROM public.market_stocks
WHERE is_active AND exchange = 'NSE';

GRANT SELECT ON public.market_reference_coverage TO authenticated;
GRANT SELECT ON public.market_reference_coverage TO service_role;