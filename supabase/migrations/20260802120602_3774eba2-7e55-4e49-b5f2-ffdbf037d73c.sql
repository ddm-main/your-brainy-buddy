-- 1. Calibration table hygiene: diagnostics must not masquerade as weights.
ALTER TABLE public.market_scoring_calibration
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'bucket',
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS as_of_date date,
  ADD COLUMN IF NOT EXISTS meta jsonb;

UPDATE public.market_scoring_calibration
   SET model = COALESCE(model, split_part(model_version, ':', 1)),
       as_of_date = COALESCE(as_of_date, NULLIF(split_part(model_version, ':', 2), '')::date)
 WHERE model IS NULL;

-- Distribution percentiles already live in market_score_distribution; the
-- dated breakout_v2 rows here were write-only noise in the table the
-- Calibration Lab reads.
DELETE FROM public.market_scoring_calibration WHERE model_version LIKE 'breakout_v2:%';

-- 2. One-off cleanup: rows stamped on non-trading days. No ^NSEI bar exists
--    for those dates, so forward returns can never be joined to them.
DELETE FROM public.market_score_history h
 WHERE h.trade_date >= (SELECT min(trade_date) FROM public.market_daily_prices
                         WHERE symbol = '^NSEI' AND exchange = 'NSE')
   AND NOT EXISTS (SELECT 1 FROM public.market_daily_prices b
                    WHERE b.symbol = '^NSEI' AND b.exchange = 'NSE'
                      AND b.trade_date = h.trade_date);

DELETE FROM public.market_breakout_snapshots s
 WHERE s.trade_date >= (SELECT min(trade_date) FROM public.market_daily_prices
                         WHERE symbol = '^NSEI' AND exchange = 'NSE')
   AND NOT EXISTS (SELECT 1 FROM public.market_daily_prices b
                    WHERE b.symbol = '^NSEI' AND b.exchange = 'NSE'
                      AND b.trade_date = s.trade_date);

-- 3. Deterministic evaluation batch.
CREATE OR REPLACE FUNCTION public.evaluate_score_history_forward(_limit integer DEFAULT 200000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- Without a stable order the LIMIT revisits the same rows every run and
    -- starves the oldest unevaluated snapshots forever.
    ORDER BY h.trade_date ASC, h.symbol ASC
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
$function$;

-- 4. Calibration fit: pool populations rather than emitting a sentinel, and
--    store diagnostics as diagnostics.
CREATE OR REPLACE FUNCTION public.fit_score_calibration(
  _model text DEFAULT 'breakout_v4',
  _min_n integer DEFAULT 200,
  _min_symbols integer DEFAULT 60,
  _min_sessions integer DEFAULT 20,
  _min_symbols_neutral integer DEFAULT 15
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  ts timestamptz := now();
  pop text;
  n_sym integer;
  n_sess integer;
  n_rows integer;
  raw_share numeric;
BEGIN
  CREATE TEMP TABLE _fit_all ON COMMIT DROP AS
  SELECT h.symbol, h.trade_date, h.score::numeric AS score,
         h.fwd_ret_21d, h.fwd_rel_21d,
         COALESCE(h.context_neutral, false) AS neutral,
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
    AND h.is_liquid_tradable IS TRUE;

  -- Pick the widest population that clears the floors: live full-context
  -- first, then the deliberately narrow replay set (lower symbol floor), then
  -- both pooled. Only when nothing clears do we record "not fitted".
  SELECT count(*), count(DISTINCT symbol), count(DISTINCT trade_date)
    INTO n_rows, n_sym, n_sess FROM _fit_all WHERE neutral IS FALSE;
  IF n_rows >= _min_n AND n_sym >= _min_symbols AND n_sess >= _min_sessions THEN
    pop := 'full_context';
  ELSE
    SELECT count(*), count(DISTINCT symbol), count(DISTINCT trade_date)
      INTO n_rows, n_sym, n_sess FROM _fit_all WHERE neutral IS TRUE;
    IF n_rows >= _min_n AND n_sym >= _min_symbols_neutral AND n_sess >= _min_sessions THEN
      pop := 'replayed_neutral';
    ELSE
      SELECT count(*), count(DISTINCT symbol), count(DISTINCT trade_date)
        INTO n_rows, n_sym, n_sess FROM _fit_all;
      IF n_rows >= _min_n AND n_sym >= _min_symbols_neutral AND n_sess >= _min_sessions THEN
        pop := 'mixed';
      ELSE
        pop := NULL;
      END IF;
    END IF;
  END IF;

  DELETE FROM public.market_scoring_calibration WHERE model_version = _model;

  IF pop IS NULL THEN
    INSERT INTO public.market_scoring_calibration
      (model_version, model, as_of_date, kind, component, weight, r2, sample_n, computed_at, meta)
    VALUES (_model, _model, ts::date, 'diagnostic', 'not_fitted', 0, NULL, n_rows, ts,
            jsonb_build_object(
              'reason', 'insufficient_coverage',
              'rows', n_rows, 'symbols', n_sym, 'sessions', n_sess,
              'min_rows', _min_n, 'min_symbols', _min_symbols,
              'min_symbols_neutral', _min_symbols_neutral, 'min_sessions', _min_sessions,
              'live_rows', (SELECT count(*) FROM _fit_all WHERE neutral IS FALSE),
              'neutral_rows', (SELECT count(*) FROM _fit_all WHERE neutral IS TRUE)));
    RETURN 0;
  END IF;

  CREATE TEMP TABLE _fit_rows ON COMMIT DROP AS
  SELECT * FROM _fit_all
   WHERE pop = 'mixed'
      OR (pop = 'full_context' AND neutral IS FALSE)
      OR (pop = 'replayed_neutral' AND neutral IS TRUE);

  SELECT CASE WHEN count(*) > 0
              THEN round(100.0 * count(*) FILTER (WHERE has_raw) / count(*), 1)
              ELSE 0 END
    INTO raw_share FROM _fit_rows;

  INSERT INTO public.market_scoring_calibration
    (model_version, model, as_of_date, kind, component, weight, r2, sample_n, computed_at, meta)
  VALUES (_model, _model, ts::date, 'diagnostic', 'coverage', 0, NULL, n_rows, ts,
          jsonb_build_object('population', pop, 'rows', n_rows, 'symbols', n_sym,
                             'sessions', n_sess, 'raw_detail_pct', raw_share));

  INSERT INTO public.market_scoring_calibration
    (model_version, model, as_of_date, kind, component, weight, r2, sample_n, computed_at)
  SELECT _model, _model, ts::date, 'model', 'score_vs_fwd_ret_21d',
         round(regr_slope(fwd_ret_21d, score)::numeric, 4),
         round(regr_r2(fwd_ret_21d, score)::numeric, 4), count(*)::integer, ts
  FROM _fit_rows WHERE fwd_ret_21d IS NOT NULL
  HAVING regr_slope(fwd_ret_21d, score) IS NOT NULL;

  INSERT INTO public.market_scoring_calibration
    (model_version, model, as_of_date, kind, component, weight, r2, sample_n, computed_at)
  SELECT _model, _model, ts::date, 'model', 'score_vs_fwd_rel_21d',
         round(regr_slope(fwd_rel_21d, score)::numeric, 4),
         round(regr_r2(fwd_rel_21d, score)::numeric, 4), count(*)::integer, ts
  FROM _fit_rows WHERE fwd_rel_21d IS NOT NULL
  HAVING regr_slope(fwd_rel_21d, score) IS NOT NULL;

  INSERT INTO public.market_scoring_calibration
    (model_version, model, as_of_date, kind, component, weight, r2, sample_n, computed_at)
  SELECT _model, _model, ts::date, 'bucket', b.key,
         round(regr_slope(f.fwd_rel_21d, (b.value)::numeric)::numeric, 4),
         round(regr_r2(f.fwd_rel_21d, (b.value)::numeric)::numeric, 4),
         count(*)::integer, ts
  FROM _fit_rows f
  CROSS JOIN LATERAL jsonb_each_text(COALESCE(f.vals, '{}'::jsonb)) AS b(key, value)
  WHERE f.fwd_rel_21d IS NOT NULL AND b.value ~ '^-?[0-9]+(\.[0-9]+)?$'
  GROUP BY b.key
  HAVING count(*) >= GREATEST(30, _min_n / 4)
     AND regr_slope(f.fwd_rel_21d, (b.value)::numeric) IS NOT NULL;

  RETURN (SELECT count(*)::integer FROM public.market_scoring_calibration
           WHERE model_version = _model AND kind <> 'diagnostic');
END;
$function$;

-- 5. Widen the replay backfill: the 130-bar floor kept the neutral pool at a
--    handful of symbols, which is why the fit never cleared its coverage bar.
CREATE OR REPLACE FUNCTION public.market_score_backfill_candidates(
  _limit integer DEFAULT 25,
  _min_rows integer DEFAULT 100,
  _min_bars integer DEFAULT 90
)
 RETURNS TABLE(symbol text, exchange text, market_cap numeric, sector text, bars integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT s.symbol,
         s.exchange,
         s.market_cap::numeric,
         s.sector,
         (SELECT count(*)::int FROM public.market_daily_prices p
           WHERE p.symbol = s.symbol AND p.exchange = s.exchange) AS bars
  FROM public.market_stocks s
  WHERE s.is_active = true
    AND s.exchange = 'NSE'
    AND (SELECT count(*) FROM public.market_score_history h
          WHERE h.symbol = s.symbol AND h.exchange = s.exchange
            AND h.model = 'breakout_v4') < GREATEST(1, _min_rows)
    AND (SELECT count(*) FROM public.market_daily_prices p
          WHERE p.symbol = s.symbol AND p.exchange = s.exchange) >= GREATEST(30, _min_bars)
  ORDER BY s.symbol
  LIMIT GREATEST(1, LEAST(_limit, 200))
$function$;

-- 6. Matches the Breakout UI's default ordering (open episodes, best
--    follow-through first).
CREATE INDEX IF NOT EXISTS market_breakout_tracker_status_ft_idx
  ON public.market_breakout_tracker (status, followthrough_score DESC NULLS LAST);