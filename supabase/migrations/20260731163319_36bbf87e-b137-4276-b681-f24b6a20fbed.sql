ALTER TABLE public.market_breakout_tracker
  ADD COLUMN IF NOT EXISTS detected_score_legacy integer,
  ADD COLUMN IF NOT EXISTS last_score_legacy integer,
  ADD COLUMN IF NOT EXISTS rank_pct numeric,
  ADD COLUMN IF NOT EXISTS mae_pct numeric,
  ADD COLUMN IF NOT EXISTS trough_low numeric,
  ADD COLUMN IF NOT EXISTS peak_high numeric,
  ADD COLUMN IF NOT EXISTS sessions_elapsed integer;

ALTER TABLE public.market_score_history
  ADD COLUMN IF NOT EXISTS raw_buckets jsonb;

CREATE OR REPLACE FUNCTION public.market_score_cohort(
  _model text DEFAULT 'breakout_v4'::text,
  _days integer DEFAULT 30,
  _threshold numeric DEFAULT 70,
  _population text DEFAULT 'all'::text
)
 RETURNS TABLE(trade_date date, n_qualified integer, matured_5 integer, matured_21 integer, avg_ret_5d numeric, avg_ret_10d numeric, avg_ret_21d numeric, avg_rel_21d numeric, hit_rate_21d numeric, avg_score numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH dates AS (
    SELECT DISTINCT h.trade_date FROM public.market_score_history h
    WHERE h.model = _model ORDER BY 1 DESC LIMIT GREATEST(1, LEAST(_days, 250))
  ), rows AS (
    SELECT h.* FROM public.market_score_history h
    JOIN dates d ON d.trade_date = h.trade_date
    WHERE h.model = _model AND h.score >= _threshold
      AND (_population <> 'fit'
           OR (COALESCE(h.is_liquid_tradable, true) IS TRUE AND h.context_neutral IS FALSE))
  )
  SELECT d.trade_date,
         count(r.id)::integer,
         count(r.fwd_ret_5d)::integer,
         count(r.fwd_ret_21d)::integer,
         round(avg(r.fwd_ret_5d), 2), round(avg(r.fwd_ret_10d), 2), round(avg(r.fwd_ret_21d), 2),
         round(avg(r.fwd_rel_21d), 2),
         round(100.0 * count(*) FILTER (WHERE r.fwd_ret_21d > 0)::numeric / NULLIF(count(r.fwd_ret_21d),0), 1),
         round(avg(r.score), 1)
  FROM dates d LEFT JOIN rows r ON r.trade_date = d.trade_date
  GROUP BY d.trade_date ORDER BY d.trade_date DESC
$function$;

CREATE OR REPLACE FUNCTION public.market_score_cohort_symbols(
  _model text DEFAULT 'breakout_v4'::text,
  _days integer DEFAULT 30,
  _threshold numeric DEFAULT 70,
  _limit integer DEFAULT 200,
  _population text DEFAULT 'all'::text
)
 RETURNS TABLE(symbol text, exchange text, appearances integer, first_date date, last_date date, max_score integer, avg_score numeric, first_ret_5d numeric, first_ret_21d numeric, first_rel_21d numeric, best_ret_21d numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH dates AS (
    SELECT DISTINCT h.trade_date FROM public.market_score_history h
    WHERE h.model = _model ORDER BY 1 DESC LIMIT GREATEST(1, LEAST(_days, 250))
  ), rows AS (
    SELECT h.* FROM public.market_score_history h
    JOIN dates d ON d.trade_date = h.trade_date
    WHERE h.model = _model AND h.score >= _threshold
      AND (_population <> 'fit'
           OR (COALESCE(h.is_liquid_tradable, true) IS TRUE AND h.context_neutral IS FALSE))
  ), firsts AS (
    SELECT DISTINCT ON (symbol, exchange) symbol, exchange, trade_date,
           fwd_ret_5d, fwd_ret_21d, fwd_rel_21d
    FROM rows ORDER BY symbol, exchange, trade_date ASC
  )
  SELECT r.symbol, r.exchange, count(*)::integer, min(r.trade_date), max(r.trade_date),
         max(r.score)::integer, round(avg(r.score), 1),
         f.fwd_ret_5d, f.fwd_ret_21d, f.fwd_rel_21d, max(r.fwd_ret_21d)
  FROM rows r
  JOIN firsts f ON f.symbol = r.symbol AND f.exchange = r.exchange
  GROUP BY r.symbol, r.exchange, f.fwd_ret_5d, f.fwd_ret_21d, f.fwd_rel_21d
  ORDER BY count(*) DESC, max(r.score) DESC
  LIMIT GREATEST(1, LEAST(_limit, 1000))
$function$;

CREATE OR REPLACE FUNCTION public.score_history_coverage(_model text DEFAULT 'breakout_v4'::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'rows', count(*),
    'symbols', count(DISTINCT symbol),
    'sessions', count(DISTINCT trade_date),
    'first_date', min(trade_date),
    'last_date', max(trade_date),
    'matured_21', count(*) FILTER (WHERE fwd_ret_21d IS NOT NULL),
    'matured_21_fit', count(*) FILTER (WHERE fwd_ret_21d IS NOT NULL
      AND COALESCE(is_liquid_tradable, true) IS TRUE AND context_neutral IS FALSE),
    'symbols_matured', count(DISTINCT symbol) FILTER (WHERE fwd_ret_21d IS NOT NULL),
    'bench_covered_21', count(*) FILTER (WHERE fwd_rel_21d IS NOT NULL),
    'live_rows', count(*) FILTER (WHERE context_neutral IS FALSE),
    'neutral_rows', count(*) FILTER (WHERE context_neutral IS TRUE)
  )
  FROM public.market_score_history WHERE model = _model
$function$;

GRANT EXECUTE ON FUNCTION public.score_history_coverage(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.market_score_cohort(text, integer, numeric, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.market_score_cohort_symbols(text, integer, numeric, integer, text) TO authenticated, service_role;