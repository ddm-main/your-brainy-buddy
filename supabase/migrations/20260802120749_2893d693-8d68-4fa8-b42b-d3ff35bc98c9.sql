CREATE OR REPLACE FUNCTION public.stamp_score_history_ranks(_model text DEFAULT 'breakout_v4'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  n integer := 0;
  -- Below this many liquid names a session's own percentiles are noise: a
  -- 3-row day made "top 2%" mean the single best of three. Fall back to the
  -- absolute 70/55/40 constants there.
  min_pool constant integer := 200;
BEGIN
  WITH ranked AS (
    SELECT h.id,
           round((percent_rank() OVER (
             PARTITION BY h.trade_date, h.model, h.context_neutral
             ORDER BY h.score
           ) * 100)::numeric, 1) AS pct
    FROM public.market_score_history h
    WHERE h.model = _model AND h.score IS NOT NULL AND h.is_liquid_tradable IS TRUE
  )
  UPDATE public.market_score_history h
  SET rank_pct = r.pct
  FROM ranked r
  WHERE h.id = r.id AND (h.rank_pct IS NULL OR h.rank_pct <> r.pct);

  GET DIAGNOSTICS n = ROW_COUNT;

  WITH cuts AS (
    SELECT h.id,
           CASE
             WHEN h.score >= COALESCE(c.strong_cut, 70)   THEN 'strong'
             WHEN h.score >= COALESCE(c.moderate_cut, 55) THEN 'moderate'
             WHEN h.score >= COALESCE(c.watch_cut, 40)    THEN 'watch'
             ELSE 'weak' END AS band
    FROM public.market_score_history h
    LEFT JOIN LATERAL (
      SELECT d.strong_cut, d.moderate_cut, d.watch_cut
      FROM public.market_score_distribution d
      WHERE d.trade_date = h.trade_date AND d.model = h.model
        AND d.strong_cut IS NOT NULL AND COALESCE(d.n, 0) >= min_pool
    ) c ON true
    WHERE h.model = _model AND h.score IS NOT NULL
  )
  UPDATE public.market_score_history h
  SET band = k.band
  FROM cuts k
  WHERE h.id = k.id AND h.band IS DISTINCT FROM k.band;

  RETURN n;
END;
$function$;