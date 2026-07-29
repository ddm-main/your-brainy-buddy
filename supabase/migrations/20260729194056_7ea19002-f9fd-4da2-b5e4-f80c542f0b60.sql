CREATE INDEX IF NOT EXISTS market_score_history_symbol_idx
  ON public.market_score_history (symbol, exchange, model, trade_date DESC);

CREATE OR REPLACE VIEW public.market_score_band_stats
WITH (security_invoker = true) AS
SELECT
  h.model,
  h.band,
  count(*)::int                                        AS sample_n,
  count(h.fwd_ret_5d)::int                             AS sample_5d,
  count(h.fwd_ret_10d)::int                            AS sample_10d,
  count(h.fwd_ret_21d)::int                            AS sample_21d,
  round(avg(h.fwd_ret_5d)::numeric, 2)                 AS avg_ret_5d,
  round(avg(h.fwd_ret_10d)::numeric, 2)                AS avg_ret_10d,
  round(avg(h.fwd_ret_21d)::numeric, 2)                AS avg_ret_21d,
  round(100.0 * count(*) FILTER (WHERE h.fwd_ret_5d  > 0) / NULLIF(count(h.fwd_ret_5d), 0),  1) AS hit_rate_5d,
  round(100.0 * count(*) FILTER (WHERE h.fwd_ret_10d > 0) / NULLIF(count(h.fwd_ret_10d), 0), 1) AS hit_rate_10d,
  round(100.0 * count(*) FILTER (WHERE h.fwd_ret_21d > 0) / NULLIF(count(h.fwd_ret_21d), 0), 1) AS hit_rate_21d,
  min(h.trade_date)                                    AS first_date,
  max(h.trade_date)                                    AS last_date
FROM public.market_score_history h
WHERE h.band IS NOT NULL
GROUP BY h.model, h.band;

GRANT SELECT ON public.market_score_band_stats TO authenticated;
GRANT SELECT ON public.market_score_band_stats TO service_role;