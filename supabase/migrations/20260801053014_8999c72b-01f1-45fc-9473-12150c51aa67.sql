CREATE OR REPLACE FUNCTION public.evaluate_score_history_forward(_limit integer DEFAULT 200000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer := 0;
  since date;
BEGIN
  SELECT min(trade_date) INTO since
  FROM public.market_score_history h
  WHERE h.fwd_ret_21d IS NULL
     OR (h.fwd_rel_21d IS NULL
         AND EXISTS (SELECT 1 FROM public.market_daily_prices b
                      WHERE b.symbol = '^NSEI' AND b.exchange = 'NSE'
                        AND b.trade_date = h.trade_date));

  IF since IS NULL THEN
    RETURN 0;
  END IF;

  -- The NSE index trades every session, so its bars ARE the session calendar.
  -- Leading over a symbol's own stored bars silently counts holes as sessions.
  WITH cal AS (
    SELECT p.trade_date,
           row_number() OVER (ORDER BY p.trade_date) AS rn,
           COALESCE(p.close_adjusted, p.close) AS c
    FROM public.market_daily_prices p
    WHERE p.symbol = '^NSEI' AND p.exchange = 'NSE'
      AND p.trade_date >= since
      AND COALESCE(p.close_adjusted, p.close) IS NOT NULL
  ), calmap AS (
    SELECT a.trade_date AS d0, a.c AS b0,
           c5.trade_date  AS d5,  c5.c  AS b5,
           c10.trade_date AS d10, c10.c AS b10,
           c21.trade_date AS d21, c21.c AS b21
    FROM cal a
    LEFT JOIN cal c5  ON c5.rn  = a.rn + 5
    LEFT JOIN cal c10 ON c10.rn = a.rn + 10
    LEFT JOIN cal c21 ON c21.rn = a.rn + 21
  ), tgt AS (
    SELECT h.id,
           (COALESCE(p5.close_adjusted,  p5.close)  / NULLIF(COALESCE(p0.close_adjusted, p0.close), 0) - 1) * 100 AS r5,
           (COALESCE(p10.close_adjusted, p10.close) / NULLIF(COALESCE(p0.close_adjusted, p0.close), 0) - 1) * 100 AS r10,
           (COALESCE(p21.close_adjusted, p21.close) / NULLIF(COALESCE(p0.close_adjusted, p0.close), 0) - 1) * 100 AS r21,
           (m.b5  / NULLIF(m.b0, 0) - 1) * 100 AS br5,
           (m.b10 / NULLIF(m.b0, 0) - 1) * 100 AS br10,
           (m.b21 / NULLIF(m.b0, 0) - 1) * 100 AS br21
    FROM public.market_score_history h
    JOIN calmap m ON m.d0 = h.trade_date
    JOIN public.market_daily_prices p0
      ON p0.symbol = h.symbol AND p0.exchange = h.exchange AND p0.trade_date = h.trade_date
    LEFT JOIN public.market_daily_prices p5
      ON p5.symbol = h.symbol AND p5.exchange = h.exchange AND p5.trade_date = m.d5
    LEFT JOIN public.market_daily_prices p10
      ON p10.symbol = h.symbol AND p10.exchange = h.exchange AND p10.trade_date = m.d10
    LEFT JOIN public.market_daily_prices p21
      ON p21.symbol = h.symbol AND p21.exchange = h.exchange AND p21.trade_date = m.d21
    WHERE (h.fwd_ret_21d IS NULL OR (h.fwd_rel_21d IS NULL AND m.b21 IS NOT NULL))
      AND COALESCE(p0.close_adjusted, p0.close) IS NOT NULL
      AND COALESCE(p5.close_adjusted, p5.close) IS NOT NULL
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

CREATE OR REPLACE FUNCTION public.refresh_score_distribution(_model text DEFAULT 'breakout_v4'::text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n integer;
BEGIN
  -- Cut-offs match percentileBandCuts() in the scorer: top 2% / 10% / 25%.
  -- Live (full-context) rows own a session; replayed rows only fill sessions
  -- with no live rows, so percentiles never mix populations.
  WITH src AS (
    SELECT h.trade_date, h.model, h.score, h.context_neutral,
           bool_or(h.context_neutral IS FALSE) OVER (PARTITION BY h.trade_date, h.model) AS has_live
    FROM public.market_score_history h
    WHERE h.model = _model
      AND h.score IS NOT NULL
      AND h.is_liquid_tradable IS TRUE
  ), pick AS (
    SELECT trade_date, model, score FROM src
    WHERE (has_live AND context_neutral IS FALSE) OR (NOT has_live)
  )
  INSERT INTO public.market_score_distribution
    (trade_date, model, n, p50, p70, p90, max, strong_cut, moderate_cut, watch_cut, updated_at)
  SELECT trade_date, model, count(*)::integer,
         round(percentile_cont(0.50) WITHIN GROUP (ORDER BY score)::numeric, 1),
         round(percentile_cont(0.70) WITHIN GROUP (ORDER BY score)::numeric, 1),
         round(percentile_cont(0.90) WITHIN GROUP (ORDER BY score)::numeric, 1),
         max(score)::numeric,
         round(percentile_cont(0.98) WITHIN GROUP (ORDER BY score)::numeric, 1),
         round(percentile_cont(0.90) WITHIN GROUP (ORDER BY score)::numeric, 1),
         round(percentile_cont(0.75) WITHIN GROUP (ORDER BY score)::numeric, 1),
         now()
  FROM pick
  GROUP BY trade_date, model
  ON CONFLICT (trade_date, model) DO UPDATE SET
    n = EXCLUDED.n, p50 = EXCLUDED.p50, p70 = EXCLUDED.p70, p90 = EXCLUDED.p90,
    max = EXCLUDED.max, strong_cut = EXCLUDED.strong_cut,
    moderate_cut = EXCLUDED.moderate_cut, watch_cut = EXCLUDED.watch_cut,
    updated_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.fit_score_calibration(_model text DEFAULT 'breakout_v4'::text, _min_n integer DEFAULT 200)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ts timestamptz := now();
  pop text := 'full_context';
  min_symbols constant integer := 60;
  min_sessions constant integer := 20;
  n_sym integer;
  n_sess integer;
  raw_share numeric;
BEGIN
  -- `vals` is the coverage-independent bucket view: the stored raw 0-1 values
  -- when the snapshot has them, else each bucket's share of the row's earned
  -- points. Regressing on renormalised POINTS injected coverage noise into
  -- every bucket slope.
  CREATE TEMP TABLE _fit_rows ON COMMIT DROP AS
  SELECT h.symbol, h.trade_date, h.score::numeric AS score,
         h.buckets, h.raw_buckets, h.fwd_ret_21d, h.fwd_rel_21d,
         (h.raw_buckets -> 'raw') IS NOT NULL AS has_raw,
         COALESCE(
           h.raw_buckets -> 'raw',
           (SELECT jsonb_object_agg(b.key,
                     CASE WHEN s.tot > 0 THEN round((b.value::numeric / s.tot), 4) ELSE 0 END)
              FROM jsonb_each_text(COALESCE(h.buckets, '{}'::jsonb)) AS b(key, value)
              CROSS JOIN (SELECT sum(v.value::numeric) AS tot
                            FROM jsonb_each_text(COALESCE(h.buckets, '{}'::jsonb)) AS v(key, value)
                           WHERE v.value ~ '^-?[0-9]+(\.[0-9]+)?$') s
             WHERE b.value ~ '^-?[0-9]+(\.[0-9]+)?$')
         ) AS vals
  FROM public.market_score_history h
  WHERE h.model = _model AND h.fwd_ret_21d IS NOT NULL AND h.score IS NOT NULL
    AND h.is_liquid_tradable IS TRUE AND h.context_neutral IS FALSE;

  SELECT count(DISTINCT symbol), count(DISTINCT trade_date) INTO n_sym, n_sess FROM _fit_rows;

  IF (SELECT count(*) FROM _fit_rows) < _min_n OR n_sym < min_symbols OR n_sess < min_sessions THEN
    pop := 'replayed_neutral';
    DELETE FROM _fit_rows WHERE true;
    INSERT INTO _fit_rows
    SELECT h.symbol, h.trade_date, h.score::numeric,
           h.buckets, h.raw_buckets, h.fwd_ret_21d, h.fwd_rel_21d,
           (h.raw_buckets -> 'raw') IS NOT NULL,
           COALESCE(
             h.raw_buckets -> 'raw',
             (SELECT jsonb_object_agg(b.key,
                       CASE WHEN s.tot > 0 THEN round((b.value::numeric / s.tot), 4) ELSE 0 END)
                FROM jsonb_each_text(COALESCE(h.buckets, '{}'::jsonb)) AS b(key, value)
                CROSS JOIN (SELECT sum(v.value::numeric) AS tot
                              FROM jsonb_each_text(COALESCE(h.buckets, '{}'::jsonb)) AS v(key, value)
                             WHERE v.value ~ '^-?[0-9]+(\.[0-9]+)?$') s
               WHERE b.value ~ '^-?[0-9]+(\.[0-9]+)?$')
           )
    FROM public.market_score_history h
    WHERE h.model = _model AND h.fwd_ret_21d IS NOT NULL AND h.score IS NOT NULL
      AND h.is_liquid_tradable IS TRUE AND h.context_neutral IS TRUE;
    SELECT count(DISTINCT symbol), count(DISTINCT trade_date) INTO n_sym, n_sess FROM _fit_rows;
  END IF;

  SELECT CASE WHEN count(*) > 0
              THEN round(100.0 * count(*) FILTER (WHERE has_raw) / count(*), 1)
              ELSE 0 END
    INTO raw_share FROM _fit_rows;

  IF (SELECT count(*) FROM _fit_rows) < _min_n OR n_sym < min_symbols OR n_sess < min_sessions THEN
    DELETE FROM public.market_scoring_calibration WHERE model_version = _model;
    INSERT INTO public.market_scoring_calibration (model_version, component, weight, r2, sample_n, computed_at)
    VALUES (_model,
            'coverage:insufficient population=' || pop || ' symbols=' || n_sym || ' sessions=' || n_sess,
            0, NULL, (SELECT count(*)::integer FROM _fit_rows), ts);
    RETURN 0;
  END IF;

  DELETE FROM public.market_scoring_calibration WHERE model_version = _model;

  INSERT INTO public.market_scoring_calibration (model_version, component, weight, r2, sample_n, computed_at)
  SELECT _model, 'population:' || pop, 0, NULL, count(*)::integer, ts FROM _fit_rows;

  INSERT INTO public.market_scoring_calibration (model_version, component, weight, r2, sample_n, computed_at)
  VALUES (_model, 'coverage:symbols', n_sym, NULL, n_sym, ts),
         (_model, 'coverage:sessions', n_sess, NULL, n_sess, ts),
         (_model, 'coverage:raw_detail_pct', raw_share, NULL, n_sym, ts);

  INSERT INTO public.market_scoring_calibration (model_version, component, weight, r2, sample_n, computed_at)
  SELECT _model, 'score_vs_fwd_ret_21d',
         round(regr_slope(fwd_ret_21d, score)::numeric, 4),
         round(regr_r2(fwd_ret_21d, score)::numeric, 4), count(*)::integer, ts
  FROM _fit_rows WHERE fwd_ret_21d IS NOT NULL
  HAVING regr_slope(fwd_ret_21d, score) IS NOT NULL;

  INSERT INTO public.market_scoring_calibration (model_version, component, weight, r2, sample_n, computed_at)
  SELECT _model, 'score_vs_fwd_rel_21d',
         round(regr_slope(fwd_rel_21d, score)::numeric, 4),
         round(regr_r2(fwd_rel_21d, score)::numeric, 4), count(*)::integer, ts
  FROM _fit_rows WHERE fwd_rel_21d IS NOT NULL
  HAVING regr_slope(fwd_rel_21d, score) IS NOT NULL;

  INSERT INTO public.market_scoring_calibration (model_version, component, weight, r2, sample_n, computed_at)
  SELECT _model, 'bucket:' || b.key,
         round(regr_slope(f.fwd_rel_21d, (b.value)::numeric)::numeric, 4),
         round(regr_r2(f.fwd_rel_21d, (b.value)::numeric)::numeric, 4),
         count(*)::integer, ts
  FROM _fit_rows f
  CROSS JOIN LATERAL jsonb_each_text(COALESCE(f.vals, '{}'::jsonb)) AS b(key, value)
  WHERE f.fwd_rel_21d IS NOT NULL AND b.value ~ '^-?[0-9]+(\.[0-9]+)?$'
  GROUP BY b.key
  HAVING count(*) >= GREATEST(30, _min_n / 4)
     AND regr_slope(f.fwd_rel_21d, (b.value)::numeric) IS NOT NULL;

  RETURN (SELECT count(*)::integer FROM public.market_scoring_calibration WHERE model_version = _model);
END;
$$;

REVOKE ALL ON FUNCTION public.evaluate_score_history_forward(integer) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_score_distribution(text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.fit_score_calibration(text, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_score_history_forward(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_score_distribution(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fit_score_calibration(text, integer) TO service_role;