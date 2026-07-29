-- 1. The Data API schema cache is stale: market_eod_nse.exchange exists in
-- Postgres but PostgREST rejects every insert with "Could not find the
-- 'exchange' column ... in the schema cache". This has blocked the NSE
-- bhavcopy sync since 2026-07-24.
NOTIFY pgrst, 'reload schema';

-- 2. Data freshness, one row per source table, in trading-session lag terms.
CREATE OR REPLACE VIEW public.market_data_freshness
WITH (security_invoker = on) AS
SELECT 'market_eod_nse'::text AS source,
       (SELECT max(trade_date) FROM public.market_eod_nse) AS latest_trade_date,
       (current_date - (SELECT max(trade_date) FROM public.market_eod_nse)) AS lag_days
UNION ALL
SELECT 'market_daily_prices',
       (SELECT max(trade_date) FROM public.market_daily_prices),
       (current_date - (SELECT max(trade_date) FROM public.market_daily_prices))
UNION ALL
SELECT 'market_stock_scores',
       (SELECT max(trade_date) FROM public.market_stock_scores),
       (current_date - (SELECT max(trade_date) FROM public.market_stock_scores))
UNION ALL
SELECT 'market_screener_snapshot',
       (SELECT max(trade_date) FROM public.market_screener_snapshot),
       (current_date - (SELECT max(trade_date) FROM public.market_screener_snapshot))
UNION ALL
SELECT 'market_breadth_daily',
       (SELECT max(trade_date) FROM public.market_breadth_daily),
       (current_date - (SELECT max(trade_date) FROM public.market_breadth_daily));

GRANT SELECT ON public.market_data_freshness TO authenticated;
GRANT SELECT ON public.market_data_freshness TO service_role;

-- 3. Per-stage pipeline health from the ingestion-run ledger, so a silently
-- failing stage is visible instead of being buried in a metadata blob.
CREATE OR REPLACE VIEW public.market_pipeline_health
WITH (security_invoker = on) AS
SELECT stage,
       max(started_at) FILTER (WHERE status IN ('ok', 'partial'))  AS last_success_at,
       max(started_at) FILTER (WHERE status = 'failed')            AS last_failure_at,
       (array_agg(COALESCE(error_message, metadata ->> 'error')
                  ORDER BY started_at DESC)
        FILTER (WHERE status = 'failed'))[1]                       AS last_error,
       count(*) FILTER (WHERE status = 'failed')                   AS failures_14d,
       count(*)                                                    AS runs_14d
FROM public.market_ingestion_runs
WHERE started_at > now() - interval '14 days'
  AND stage IS NOT NULL
GROUP BY stage;

GRANT SELECT ON public.market_pipeline_health TO authenticated;
GRANT SELECT ON public.market_pipeline_health TO service_role;