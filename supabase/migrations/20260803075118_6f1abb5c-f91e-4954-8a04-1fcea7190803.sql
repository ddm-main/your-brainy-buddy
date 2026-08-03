ALTER TABLE public.market_intraday_prices ADD COLUMN IF NOT EXISTS cum_volume BIGINT;

CREATE OR REPLACE FUNCTION public.repair_intraday_volume(p_days INT DEFAULT 10)
RETURNS TABLE(sessions_repaired INT, rows_rewritten INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  MIN_RUN CONSTANT INT := 8;
  MIN_LEVEL_TO_STEP CONSTANT NUMERIC := 10;
  grp RECORD;
  ids UUID[];
  vols NUMERIC[];
  n INT;
  i INT;
  run_start INT;
  run_end INT;
  steps NUMERIC[];
  step NUMERIC;
  jump_start INT;
  k INT;
  v_sessions INT := 0;
  v_rows INT := 0;
  touched BOOLEAN;
BEGIN
  FOR grp IN
    SELECT symbol, exchange, source, timeframe, (ts AT TIME ZONE 'Asia/Kolkata')::date AS d
    FROM public.market_intraday_prices
    WHERE ts >= now() - make_interval(days => p_days)
    GROUP BY 1,2,3,4,5
    HAVING count(*) >= MIN_RUN
  LOOP
    SELECT array_agg(id ORDER BY ts), array_agg(volume::numeric ORDER BY ts)
      INTO ids, vols
    FROM public.market_intraday_prices
    WHERE symbol = grp.symbol AND exchange = grp.exchange AND source = grp.source
      AND timeframe = grp.timeframe AND (ts AT TIME ZONE 'Asia/Kolkata')::date = grp.d;

    n := array_length(vols, 1);
    touched := false;
    i := 1;
    WHILE i <= n LOOP
      run_start := i;
      WHILE i < n AND COALESCE(vols[i+1], 0) >= COALESCE(vols[i], 0) LOOP
        i := i + 1;
      END LOOP;
      run_end := i;

      IF run_end - run_start + 1 >= MIN_RUN THEN
        steps := ARRAY[]::NUMERIC[];
        FOR k IN run_start+1 .. run_end LOOP
          IF vols[k] - vols[k-1] > 0 THEN steps := steps || (vols[k] - vols[k-1]); END IF;
        END LOOP;
        IF array_length(steps, 1) > 0 THEN
          SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY s) INTO step FROM unnest(steps) AS s;
          IF step > 0 AND vols[run_end] / step >= MIN_LEVEL_TO_STEP THEN
            -- a run can start one bar before the counter does
            jump_start := CASE WHEN (vols[run_start+1] - vols[run_start]) > 5 * step
                               THEN run_start + 1 ELSE run_start END;
            FOR k IN REVERSE run_end .. jump_start + 1 LOOP
              UPDATE public.market_intraday_prices
                 SET cum_volume = COALESCE(cum_volume, vols[k]::bigint),
                     volume = GREATEST(0, vols[k] - vols[k-1])::bigint
               WHERE id = ids[k];
              v_rows := v_rows + 1;
            END LOOP;
            UPDATE public.market_intraday_prices
               SET cum_volume = COALESCE(cum_volume, vols[jump_start]::bigint),
                   volume = LEAST(vols[jump_start], step)::bigint
             WHERE id = ids[jump_start];
            v_rows := v_rows + 1;
            touched := true;
          END IF;
        END IF;
      END IF;
      i := i + 1;
    END LOOP;

    IF touched THEN v_sessions := v_sessions + 1; END IF;
  END LOOP;

  RETURN QUERY SELECT v_sessions, v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.repair_intraday_volume(INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.repair_intraday_volume(INT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repair_intraday_volume(INT) TO service_role;

SELECT * FROM public.repair_intraday_volume(10);