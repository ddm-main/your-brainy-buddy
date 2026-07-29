-- 1. New columns on the history snapshot ------------------------------------
ALTER TABLE public.market_score_history
  ADD COLUMN IF NOT EXISTS fwd_rel_5d numeric,
  ADD COLUMN IF NOT EXISTS fwd_rel_10d numeric,
  ADD COLUMN IF NOT EXISTS fwd_rel_21d numeric,
  ADD COLUMN IF NOT EXISTS is_liquid_tradable boolean,
  ADD COLUMN IF NOT EXISTS context_neutral boolean NOT NULL DEFAULT false;

-- 2. Band stats: absolute AND benchmark-relative ------------------------------
DROP VIEW IF EXISTS public.market_score_band_stats;
CREATE VIEW public.market_score_band_stats
WITH (security_invoker = true) AS
SELECT
  h.model,
  h.band,
  count(*)::integer                                        AS sample_n,
  count(*) FILTER (WHERE h.context_neutral)::integer       AS neutral_n,
  count(*) FILTER (WHERE h.is_liquid_tradable IS TRUE)::integer AS liquid_n,
  count(h.fwd_ret_5d)::integer                             AS sample_5d,
  count(h.fwd_ret_10d)::integer                            AS sample_10d,
  count(h.fwd_ret_21d)::integer                            AS sample_21d,
  round(avg(h.fwd_ret_5d), 2)                              AS avg_ret_5d,
  round(avg(h.fwd_ret_10d), 2)                             AS avg_ret_10d,
  round(avg(h.fwd_ret_21d), 2)                             AS avg_ret_21d,
  round(avg(h.fwd_rel_5d), 2)                              AS avg_rel_5d,
  round(avg(h.fwd_rel_10d), 2)                             AS avg_rel_10d,
  round(avg(h.fwd_rel_21d), 2)                             AS avg_rel_21d,
  round(100.0 * count(*) FILTER (WHERE h.fwd_ret_5d > 0) / NULLIF(count(h.fwd_ret_5d), 0), 1)   AS hit_rate_5d,
  round(100.0 * count(*) FILTER (WHERE h.fwd_ret_10d > 0) / NULLIF(count(h.fwd_ret_10d), 0), 1) AS hit_rate_10d,
  round(100.0 * count(*) FILTER (WHERE h.fwd_ret_21d > 0) / NULLIF(count(h.fwd_ret_21d), 0), 1) AS hit_rate_21d,
  round(100.0 * count(*) FILTER (WHERE h.fwd_rel_5d > 0) / NULLIF(count(h.fwd_rel_5d), 0), 1)   AS rel_hit_rate_5d,
  round(100.0 * count(*) FILTER (WHERE h.fwd_rel_10d > 0) / NULLIF(count(h.fwd_rel_10d), 0), 1) AS rel_hit_rate_10d,
  round(100.0 * count(*) FILTER (WHERE h.fwd_rel_21d > 0) / NULLIF(count(h.fwd_rel_21d), 0), 1) AS rel_hit_rate_21d,
  min(h.trade_date)                                        AS first_date,
  max(h.trade_date)                                        AS last_date
FROM public.market_score_history h
WHERE h.band IS NOT NULL
GROUP BY h.model, h.band;

GRANT SELECT ON public.market_score_band_stats TO authenticated;
GRANT SELECT ON public.market_score_band_stats TO service_role;

-- 3. Forward-return evaluation, split-adjusted + benchmark-relative -----------
CREATE OR REPLACE FUNCTION public.evaluate_score_history_forward(_limit integer DEFAULT 200000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  n integer := 0;
  since date;
BEGIN
  SELECT min(trade_date) INTO since
  FROM public.market_score_history
  WHERE fwd_ret_21d IS NULL;

  IF since IS NULL THEN
    RETURN 0;
  END IF;

  WITH bench AS (
    SELECT p.trade_date,
           row_number() OVER (ORDER BY p.trade_date) AS rn,
           COALESCE(p.close_adjusted, p.close) AS c
    FROM public.market_daily_prices p
    WHERE p.symbol = '^NSEI' AND p.exchange = 'NSE'
      AND p.trade_date >= since
      AND COALESCE(p.close_adjusted, p.close) IS NOT NULL
  ), bench_fwd AS (
    SELECT trade_date,
           (lead(c, 5)  OVER w / NULLIF(c, 0) - 1) * 100 AS r5,
           (lead(c, 10) OVER w / NULLIF(c, 0) - 1) * 100 AS r10,
           (lead(c, 21) OVER w / NULLIF(c, 0) - 1) * 100 AS r21
    FROM bench
    WINDOW w AS (ORDER BY rn)
  ), px AS (
    SELECT p.symbol, p.exchange, p.trade_date,
           COALESCE(p.close_adjusted, p.close) AS c
    FROM public.market_daily_prices p
    WHERE p.exchange = 'NSE'
      AND p.trade_date >= since
      AND COALESCE(p.close_adjusted, p.close) IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.market_score_history s
        WHERE s.symbol = p.symbol AND s.exchange = p.exchange
      )
  ), fwd AS (
    SELECT symbol, exchange, trade_date,
           (lead(c, 5)  OVER w / NULLIF(c, 0) - 1) * 100 AS r5,
           (lead(c, 10) OVER w / NULLIF(c, 0) - 1) * 100 AS r10,
           (lead(c, 21) OVER w / NULLIF(c, 0) - 1) * 100 AS r21
    FROM px
    WINDOW w AS (PARTITION BY symbol, exchange ORDER BY trade_date)
  ), tgt AS (
    SELECT h.id, f.r5, f.r10, f.r21, b.r5 AS br5, b.r10 AS br10, b.r21 AS br21
    FROM public.market_score_history h
    JOIN fwd f
      ON f.symbol = h.symbol AND f.exchange = h.exchange AND f.trade_date = h.trade_date
    LEFT JOIN bench_fwd b ON b.trade_date = h.trade_date
    WHERE h.fwd_ret_21d IS NULL
      AND f.r5 IS NOT NULL
    LIMIT GREATEST(1, _limit)
  )
  UPDATE public.market_score_history h SET
    fwd_ret_5d  = round(t.r5::numeric, 2),
    fwd_ret_10d = round(t.r10::numeric, 2),
    fwd_ret_21d = round(t.r21::numeric, 2),
    fwd_rel_5d  = round((t.r5  - t.br5)::numeric, 2),
    fwd_rel_10d = round((t.r10 - t.br10)::numeric, 2),
    fwd_rel_21d = round((t.r21 - t.br21)::numeric, 2),
    evaluated_at = CASE WHEN t.r21 IS NOT NULL THEN now() ELSE h.evaluated_at END
  FROM tgt t
  WHERE h.id = t.id;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- 4. Calibration fit: total + per-bucket, liquid & full-context rows only -----
CREATE OR REPLACE FUNCTION public.fit_score_calibration(_model text DEFAULT 'breakout_v4', _min_n integer DEFAULT 200)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  n integer := 0;
  ts timestamptz := now();
BEGIN
  CREATE TEMP TABLE _fit_rows ON COMMIT DROP AS
  SELECT h.score::numeric AS score, h.buckets, h.fwd_ret_21d, h.fwd_rel_21d
  FROM public.market_score_history h
  WHERE h.model = _model
    AND h.fwd_ret_21d IS NOT NULL
    AND h.score IS NOT NULL
    AND h.is_liquid_tradable IS TRUE
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
  HAVING count(*) >= _min_n;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN (SELECT count(*)::integer FROM public.market_scoring_calibration WHERE model_version = _model);
END;
$$;

-- 5. Daily distribution / band cut-offs rebuilt from history ------------------
CREATE OR REPLACE FUNCTION public.refresh_score_distribution(_model text DEFAULT 'breakout_v4')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE n integer;
BEGIN
  INSERT INTO public.market_score_distribution
    (trade_date, model, n, p50, p70, p90, max, strong_cut, moderate_cut, watch_cut, updated_at)
  SELECT h.trade_date, h.model, count(*)::integer,
         round(percentile_cont(0.50) WITHIN GROUP (ORDER BY h.score)::numeric, 1),
         round(percentile_cont(0.70) WITHIN GROUP (ORDER BY h.score)::numeric, 1),
         round(percentile_cont(0.90) WITHIN GROUP (ORDER BY h.score)::numeric, 1),
         max(h.score)::numeric,
         round(percentile_cont(0.90) WITHIN GROUP (ORDER BY h.score)::numeric, 1),
         round(percentile_cont(0.70) WITHIN GROUP (ORDER BY h.score)::numeric, 1),
         round(percentile_cont(0.50) WITHIN GROUP (ORDER BY h.score)::numeric, 1),
         now()
  FROM public.market_score_history h
  WHERE h.model = _model
    AND h.score IS NOT NULL
    AND COALESCE(h.is_liquid_tradable, true) IS TRUE
  GROUP BY h.trade_date, h.model
  ON CONFLICT (trade_date, model) DO UPDATE SET
    n = EXCLUDED.n, p50 = EXCLUDED.p50, p70 = EXCLUDED.p70, p90 = EXCLUDED.p90,
    max = EXCLUDED.max, strong_cut = EXCLUDED.strong_cut,
    moderate_cut = EXCLUDED.moderate_cut, watch_cut = EXCLUDED.watch_cut,
    updated_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- 6. Retention ---------------------------------------------------------------
INSERT INTO public.system_retention_config (key, days, note)
VALUES ('market_score_history', 400, 'Daily v4 score snapshots + forward returns; ~2.8k rows/session.')
ON CONFLICT (key) DO UPDATE SET days = EXCLUDED.days, note = EXCLUDED.note, updated_at = now();

CREATE OR REPLACE FUNCTION public.prune_old_data(_aggressive boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  started timestamptz := clock_timestamp();
  cfg jsonb;
  res jsonb := '{}'::jsonb;
  n integer;
  total integer := 0;
  d_tracked integer;
  d_other integer;
  d_inactive integer;
  size_after bigint;
  mode text := CASE WHEN _aggressive THEN 'aggressive' ELSE 'normal' END;

  simple_targets text[][] := ARRAY[
    ['market_provider_health','created_at'],
    ['market_provider_observations','created_at'],
    ['market_value_audit','checked_at'],
    ['market_indicators_cache','computed_at'],
    ['market_intraday_prices','ts'],
    ['market_ingestion_runs','started_at'],
    ['market_reference_audit_runs','created_at'],
    ['market_ticker_trace','created_at'],
    ['market_alert_events','created_at'],
    ['market_autotrade_log','created_at'],
    ['market_breakout_snapshots','computed_at'],
    ['market_option_chain_snapshots','captured_at'],
    ['market_score_history','trade_date'],
    ['market_news','created_at'],
    ['jarvis_interactions','created_at'],
    ['gmail_sync_runs','created_at'],
    ['detection_runs','created_at']
  ];
  t text; col text; keep_days integer; i integer;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'only admins can run maintenance';
  END IF;

  SELECT jsonb_object_agg(c.key, c.days) INTO cfg FROM public.system_retention_config c;

  FOR i IN 1 .. array_length(simple_targets, 1) LOOP
    t := simple_targets[i][1];
    col := simple_targets[i][2];
    keep_days := COALESCE((cfg ->> t)::int, 30);
    IF _aggressive THEN keep_days := GREATEST(1, keep_days / 3); END IF;
    n := public.prune_batched(format(
      'DELETE FROM public.%I WHERE ctid IN (SELECT ctid FROM public.%I WHERE %I < now() - interval ''%s days'' LIMIT 50000)',
      t, t, col, keep_days));
    IF n > 0 THEN res := res || jsonb_build_object(t, n); total := total + n; END IF;
  END LOOP;

  n := public.prune_batched(format(
    'DELETE FROM public.market_eod_nse WHERE ctid IN (SELECT ctid FROM public.market_eod_nse WHERE trade_date < (SELECT COALESCE(min(d), ''1900-01-01''::date) FROM (SELECT DISTINCT trade_date d FROM public.market_eod_nse ORDER BY d DESC LIMIT %s) x) LIMIT 50000)',
    GREATEST(1, COALESCE((cfg ->> 'market_eod_nse')::int, 5))));
  IF n > 0 THEN res := res || jsonb_build_object('market_eod_nse', n); total := total + n; END IF;

  d_tracked  := COALESCE((cfg ->> 'prices_hot_tracked')::int, 500);
  d_other    := COALESCE((cfg ->> 'prices_hot_other')::int, 260);
  d_inactive := COALESCE((cfg ->> 'prices_inactive')::int, 180);
  IF _aggressive THEN
    d_tracked  := GREATEST(180, d_tracked - 120);
    d_other    := GREATEST(120, d_other - 60);
    d_inactive := GREATEST(90,  d_inactive - 60);
  END IF;

  DROP TABLE IF EXISTS _tracked_symbols;
  CREATE TEMP TABLE _tracked_symbols ON COMMIT DROP AS
    SELECT DISTINCT symbol FROM public.market_watchlist_items
    UNION SELECT symbol FROM public.market_holdings
    UNION SELECT symbol FROM public.market_positions
    UNION SELECT symbol FROM public.market_index_members;

  n := public.prune_batched(format(
    'DELETE FROM public.market_daily_prices WHERE ctid IN (
       SELECT p.ctid FROM public.market_daily_prices p
       WHERE p.trade_date < current_date - %s
         AND EXISTS (SELECT 1 FROM _tracked_symbols k WHERE k.symbol = p.symbol)
         AND EXISTS (SELECT 1 FROM public.market_archive_index a WHERE a.symbol = p.symbol AND a.exchange = p.exchange AND a.first_date <= p.trade_date AND a.last_date >= p.trade_date)
       LIMIT 50000)', d_tracked));
  total := total + n;
  res := res || jsonb_build_object('market_daily_prices_tracked', n);

  n := public.prune_batched(format(
    'DELETE FROM public.market_daily_prices WHERE ctid IN (
       SELECT p.ctid FROM public.market_daily_prices p
       WHERE p.trade_date < current_date - %s
         AND NOT EXISTS (SELECT 1 FROM _tracked_symbols k WHERE k.symbol = p.symbol)
         AND EXISTS (SELECT 1 FROM public.market_stocks s WHERE s.symbol = p.symbol AND s.exchange = p.exchange AND s.is_active)
       LIMIT 50000)', d_other));
  total := total + n;
  res := res || jsonb_build_object('market_daily_prices_other', n);

  n := public.prune_batched(format(
    'DELETE FROM public.market_daily_prices WHERE ctid IN (
       SELECT p.ctid FROM public.market_daily_prices p
       WHERE p.trade_date < current_date - %s
         AND NOT EXISTS (SELECT 1 FROM _tracked_symbols k WHERE k.symbol = p.symbol)
         AND NOT EXISTS (SELECT 1 FROM public.market_stocks s WHERE s.symbol = p.symbol AND s.exchange = p.exchange AND s.is_active)
       LIMIT 50000)', d_inactive));
  total := total + n;
  res := res || jsonb_build_object('market_daily_prices_inactive', n);

  n := public.prune_batched(
    'DELETE FROM public.market_daily_prices WHERE ctid IN (
       SELECT p.ctid FROM public.market_daily_prices p
       WHERE NOT EXISTS (SELECT 1 FROM public.market_stocks s WHERE s.symbol = p.symbol AND s.exchange = p.exchange)
       LIMIT 50000)');
  IF n > 0 THEN
    total := total + n;
    res := res || jsonb_build_object('market_daily_prices_orphans', n);
  END IF;

  DROP TABLE IF EXISTS _tracked_symbols;

  size_after := pg_database_size(current_database());

  INSERT INTO public.system_maintenance_log (mode, rows_deleted, total_deleted, size_bytes, duration_ms)
  VALUES (mode, res, total, size_after,
          (EXTRACT(EPOCH FROM (clock_timestamp() - started)) * 1000)::int);

  RETURN jsonb_build_object('mode', mode, 'total_deleted', total,
                            'size_bytes', size_after, 'rows_deleted', res);
END;
$function$;
