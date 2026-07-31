CREATE OR REPLACE FUNCTION public.fit_score_calibration(_model text DEFAULT 'breakout_v4'::text, _min_n integer DEFAULT 200)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  ts timestamptz := now();
  pop text := 'full_context';
  min_symbols constant integer := 60;
  min_sessions constant integer := 20;
  n_sym integer;
  n_sess integer;
BEGIN
  CREATE TEMP TABLE _fit_rows ON COMMIT DROP AS
  SELECT h.symbol, h.trade_date, h.score::numeric AS score, h.buckets, h.fwd_ret_21d, h.fwd_rel_21d
  FROM public.market_score_history h
  WHERE h.model = _model AND h.fwd_ret_21d IS NOT NULL AND h.score IS NOT NULL
    AND COALESCE(h.is_liquid_tradable, true) IS TRUE AND h.context_neutral IS FALSE;

  SELECT count(DISTINCT symbol), count(DISTINCT trade_date) INTO n_sym, n_sess FROM _fit_rows;

  IF (SELECT count(*) FROM _fit_rows) < _min_n OR n_sym < min_symbols OR n_sess < min_sessions THEN
    pop := 'replayed_neutral';
    -- WHERE true: the database refuses unqualified DELETEs, which used to make
    -- this whole function error out before it could fall back.
    DELETE FROM _fit_rows WHERE true;
    INSERT INTO _fit_rows
    SELECT h.symbol, h.trade_date, h.score::numeric, h.buckets, h.fwd_ret_21d, h.fwd_rel_21d
    FROM public.market_score_history h
    WHERE h.model = _model AND h.fwd_ret_21d IS NOT NULL AND h.score IS NOT NULL
      AND COALESCE(h.is_liquid_tradable, true) IS TRUE AND h.context_neutral IS TRUE;
    SELECT count(DISTINCT symbol), count(DISTINCT trade_date) INTO n_sym, n_sess FROM _fit_rows;
  END IF;

  IF (SELECT count(*) FROM _fit_rows) < _min_n OR n_sym < min_symbols OR n_sess < min_sessions THEN
    DELETE FROM public.market_scoring_calibration
     WHERE model_version = _model AND component LIKE 'coverage:%';
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
         (_model, 'coverage:sessions', n_sess, NULL, n_sess, ts);

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
  CROSS JOIN LATERAL jsonb_each_text(COALESCE(f.buckets, '{}'::jsonb)) AS b(key, value)
  WHERE f.fwd_rel_21d IS NOT NULL AND b.value ~ '^-?[0-9]+(\.[0-9]+)?$'
  GROUP BY b.key
  HAVING count(*) >= GREATEST(30, _min_n / 4)
     AND regr_slope(f.fwd_rel_21d, (b.value)::numeric) IS NOT NULL;

  RETURN (SELECT count(*)::integer FROM public.market_scoring_calibration WHERE model_version = _model);
END;
$function$;