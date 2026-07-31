
-- 1. Band stats, split by population ('all' vs 'fit' = liquid + full context)
DROP VIEW IF EXISTS public.market_score_band_stats;
CREATE VIEW public.market_score_band_stats AS
WITH src AS (
  SELECT h.*, 'all'::text AS population FROM public.market_score_history h WHERE h.band IS NOT NULL
  UNION ALL
  SELECT h.*, 'fit'::text FROM public.market_score_history h
   WHERE h.band IS NOT NULL AND h.context_neutral IS FALSE AND COALESCE(h.is_liquid_tradable, true) IS TRUE
)
SELECT model, band, population,
  count(*)::integer AS sample_n,
  count(*) FILTER (WHERE context_neutral)::integer AS neutral_n,
  count(*) FILTER (WHERE is_liquid_tradable IS TRUE)::integer AS liquid_n,
  count(fwd_ret_5d)::integer AS sample_5d,
  count(fwd_ret_10d)::integer AS sample_10d,
  count(fwd_ret_21d)::integer AS sample_21d,
  round(avg(fwd_ret_5d), 2) AS avg_ret_5d,
  round(avg(fwd_ret_10d), 2) AS avg_ret_10d,
  round(avg(fwd_ret_21d), 2) AS avg_ret_21d,
  round(avg(fwd_rel_5d), 2) AS avg_rel_5d,
  round(avg(fwd_rel_10d), 2) AS avg_rel_10d,
  round(avg(fwd_rel_21d), 2) AS avg_rel_21d,
  round(100.0 * count(*) FILTER (WHERE fwd_ret_5d > 0)::numeric / NULLIF(count(fwd_ret_5d),0), 1) AS hit_rate_5d,
  round(100.0 * count(*) FILTER (WHERE fwd_ret_10d > 0)::numeric / NULLIF(count(fwd_ret_10d),0), 1) AS hit_rate_10d,
  round(100.0 * count(*) FILTER (WHERE fwd_ret_21d > 0)::numeric / NULLIF(count(fwd_ret_21d),0), 1) AS hit_rate_21d,
  round(100.0 * count(*) FILTER (WHERE fwd_rel_5d > 0)::numeric / NULLIF(count(fwd_rel_5d),0), 1) AS rel_hit_rate_5d,
  round(100.0 * count(*) FILTER (WHERE fwd_rel_10d > 0)::numeric / NULLIF(count(fwd_rel_10d),0), 1) AS rel_hit_rate_10d,
  round(100.0 * count(*) FILTER (WHERE fwd_rel_21d > 0)::numeric / NULLIF(count(fwd_rel_21d),0), 1) AS rel_hit_rate_21d,
  min(trade_date) AS first_date,
  max(trade_date) AS last_date
FROM src
GROUP BY model, band, population;

GRANT SELECT ON public.market_score_band_stats TO authenticated;
GRANT SELECT ON public.market_score_band_stats TO service_role;

-- 2. Fit: stop excluding live rows where liquidity was never stamped.
CREATE OR REPLACE FUNCTION public.fit_score_calibration(_model text DEFAULT 'breakout_v4'::text, _min_n integer DEFAULT 200)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  ts timestamptz := now();
BEGIN
  CREATE TEMP TABLE _fit_rows ON COMMIT DROP AS
  SELECT h.score::numeric AS score, h.buckets, h.fwd_ret_21d, h.fwd_rel_21d
  FROM public.market_score_history h
  WHERE h.model = _model
    AND h.fwd_ret_21d IS NOT NULL
    AND h.score IS NOT NULL
    AND COALESCE(h.is_liquid_tradable, true) IS TRUE
    AND h.context_neutral IS FALSE;

  IF (SELECT count(*) FROM _fit_rows) < _min_n THEN
    RETURN 0;
  END IF;

  DELETE FROM public.market_scoring_calibration WHERE model_version = _model;

  INSERT INTO public.market_scoring_calibration (model_version, component, weight, r2, sample_n, computed_at)
  SELECT _model, 'score_vs_fwd_ret_21d',
         round(regr_slope(fwd_ret_21d, score)::numeric, 4),
         round(regr_r2(fwd_ret_21d, score)::numeric, 4),
         count(*)::integer, ts
  FROM _fit_rows WHERE fwd_ret_21d IS NOT NULL;

  INSERT INTO public.market_scoring_calibration (model_version, component, weight, r2, sample_n, computed_at)
  SELECT _model, 'score_vs_fwd_rel_21d',
         round(regr_slope(fwd_rel_21d, score)::numeric, 4),
         round(regr_r2(fwd_rel_21d, score)::numeric, 4),
         count(*)::integer, ts
  FROM _fit_rows WHERE fwd_rel_21d IS NOT NULL;

  INSERT INTO public.market_scoring_calibration (model_version, component, weight, r2, sample_n, computed_at)
  SELECT _model,
         'bucket:' || b.key,
         round(regr_slope(f.fwd_rel_21d, (b.value)::numeric)::numeric, 4),
         round(regr_r2(f.fwd_rel_21d, (b.value)::numeric)::numeric, 4),
         count(*)::integer, ts
  FROM _fit_rows f
  CROSS JOIN LATERAL jsonb_each_text(COALESCE(f.buckets, '{}'::jsonb)) AS b(key, value)
  WHERE f.fwd_rel_21d IS NOT NULL
    AND b.value ~ '^-?[0-9]+(\.[0-9]+)?$'
  GROUP BY b.key
  HAVING count(*) >= GREATEST(30, _min_n / 4);

  RETURN (SELECT count(*)::integer FROM public.market_scoring_calibration WHERE model_version = _model);
END;
$function$;

-- 3. Cohort analysis: per-session qualifiers above a score threshold
CREATE OR REPLACE FUNCTION public.market_score_cohort(
  _model text DEFAULT 'breakout_v4', _days integer DEFAULT 30, _threshold numeric DEFAULT 70)
RETURNS TABLE(
  trade_date date, n_qualified integer, matured_5 integer, matured_21 integer,
  avg_ret_5d numeric, avg_ret_10d numeric, avg_ret_21d numeric,
  avg_rel_21d numeric, hit_rate_21d numeric, avg_score numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH dates AS (
    SELECT DISTINCT h.trade_date FROM public.market_score_history h
    WHERE h.model = _model ORDER BY 1 DESC LIMIT GREATEST(1, LEAST(_days, 250))
  ), rows AS (
    SELECT h.* FROM public.market_score_history h
    JOIN dates d ON d.trade_date = h.trade_date
    WHERE h.model = _model AND h.score >= _threshold
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
$$;

-- 4. Cohort membership + persistence per symbol
CREATE OR REPLACE FUNCTION public.market_score_cohort_symbols(
  _model text DEFAULT 'breakout_v4', _days integer DEFAULT 30, _threshold numeric DEFAULT 70, _limit integer DEFAULT 200)
RETURNS TABLE(
  symbol text, exchange text, appearances integer, first_date date, last_date date,
  max_score integer, avg_score numeric, first_ret_5d numeric, first_ret_21d numeric,
  first_rel_21d numeric, best_ret_21d numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH dates AS (
    SELECT DISTINCT h.trade_date FROM public.market_score_history h
    WHERE h.model = _model ORDER BY 1 DESC LIMIT GREATEST(1, LEAST(_days, 250))
  ), rows AS (
    SELECT h.* FROM public.market_score_history h
    JOIN dates d ON d.trade_date = h.trade_date
    WHERE h.model = _model AND h.score >= _threshold
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
$$;

-- 5. Model weight versions + optimizer runs
CREATE TABLE IF NOT EXISTS public.market_score_model_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model text NOT NULL UNIQUE,
  weights jsonb NOT NULL,
  band_cuts jsonb,
  is_active boolean NOT NULL DEFAULT false,
  notes text,
  source_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.market_score_model_versions TO authenticated;
GRANT ALL ON public.market_score_model_versions TO service_role;
ALTER TABLE public.market_score_model_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "model versions readable by signed-in users" ON public.market_score_model_versions;
CREATE POLICY "model versions readable by signed-in users"
  ON public.market_score_model_versions FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "admins manage model versions" ON public.market_score_model_versions;
CREATE POLICY "admins manage model versions"
  ON public.market_score_model_versions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TABLE IF NOT EXISTS public.market_score_optimizer_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model text NOT NULL DEFAULT 'breakout_v4',
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  baseline jsonb,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  best jsonb,
  sample_n integer,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.market_score_optimizer_runs TO authenticated;
GRANT ALL ON public.market_score_optimizer_runs TO service_role;
ALTER TABLE public.market_score_optimizer_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "optimizer runs readable by signed-in users" ON public.market_score_optimizer_runs;
CREATE POLICY "optimizer runs readable by signed-in users"
  ON public.market_score_optimizer_runs FOR SELECT TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS market_score_optimizer_runs_created_idx
  ON public.market_score_optimizer_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS market_score_history_model_date_score_idx
  ON public.market_score_history (model, trade_date DESC, score DESC);
