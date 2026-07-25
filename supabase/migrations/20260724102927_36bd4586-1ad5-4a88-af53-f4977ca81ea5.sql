
-- 1) Schedule market-alerts-eval (WS3.4 gap: function existed, no cron).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'market-alerts-eval') THEN
    PERFORM cron.unschedule('market-alerts-eval');
  END IF;
  PERFORM cron.schedule(
    'market-alerts-eval',
    '* 3-10 * * 1-5',
    $cron$ SELECT public.market_cron_call('market-alerts-eval'); $cron$
  );
END $$;

-- 2) Extend pipeline status view with token coverage.
DROP VIEW IF EXISTS public.market_pipeline_status;
CREATE VIEW public.market_pipeline_status AS
SELECT
  (SELECT count(*) FROM public.market_stocks WHERE is_active) AS active_stocks,
  (SELECT count(*) FROM public.market_stocks WHERE is_active AND COALESCE(instrument_type,'EQ')='EQ') AS equities_total,
  (SELECT count(*) FROM public.market_fundamentals_global f
     JOIN public.market_stocks s USING (symbol, exchange)
    WHERE s.is_active AND COALESCE(s.instrument_type,'EQ')='EQ'
      AND f.sync_status IN ('ok','partial')) AS equities_covered,
  (SELECT count(*) FROM public.market_fundamentals_global f
     JOIN public.market_stocks s USING (symbol, exchange)
    WHERE s.is_active AND COALESCE(s.instrument_type,'EQ')='EQ'
      AND f.sector IS NOT NULL) AS equities_with_sector,
  (SELECT count(*) FROM public.market_stocks s
    WHERE s.is_active AND COALESCE(s.instrument_type,'EQ')='EQ'
      AND s.market_cap IS NOT NULL
      AND s.market_cap_source LIKE 'calc:%shares%') AS mcap_nse_covered,
  (SELECT count(*) FROM public.market_stocks s
    WHERE s.is_active AND COALESCE(s.instrument_type,'EQ')='EQ'
      AND s.market_cap IS NOT NULL) AS mcap_any_covered,
  (SELECT count(*) FROM public.market_fundamentals_global WHERE sync_status IN ('ok','partial')) AS fundamentals_covered,
  (SELECT count(*) FROM public.market_fundamentals_global WHERE sync_status = 'failed') AS fundamentals_failed,
  (SELECT max(updated_at) FROM public.market_fundamentals_global) AS fundamentals_last_updated_at,
  (SELECT max(trade_date) FROM public.market_stock_scores) AS scores_last_trade_date,
  (SELECT count(*) FROM public.market_stock_scores
    WHERE trade_date = (SELECT max(trade_date) FROM public.market_stock_scores)) AS scores_last_count,
  -- New: how many active symbols have a Kotak token (drives push-tick coverage).
  (SELECT count(*) FROM public.market_stocks
    WHERE is_active AND token IS NOT NULL AND token <> '') AS token_covered,
  CASE
    WHEN (SELECT count(*) FROM public.market_stocks WHERE is_active) = 0 THEN 0
    ELSE round(
      100.0 * (SELECT count(*) FROM public.market_stocks WHERE is_active AND token IS NOT NULL AND token <> '')
      / (SELECT count(*) FROM public.market_stocks WHERE is_active)
    )::int
  END AS token_coverage_pct;
ALTER VIEW public.market_pipeline_status SET (security_invoker = on);
GRANT SELECT ON public.market_pipeline_status TO anon, authenticated, service_role;
