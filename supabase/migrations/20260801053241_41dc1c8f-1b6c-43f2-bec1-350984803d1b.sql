CREATE OR REPLACE FUNCTION public.stamp_score_history_ranks(_model text DEFAULT 'breakout_v4'::text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n integer := 0;
BEGIN
  -- Rank inside the same day + population (live rows rank against live rows,
  -- replayed rows against replayed rows). Replayed snapshots were written with
  -- rank_pct NULL, so every query filtering on the rank dropped them silently.
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

  -- Re-label bands from the day's own cut-offs (top 2 / 10 / 25%), matching the
  -- scorer's percentileBandCuts(). Fixed 70/55/40 reported an entire weak
  -- session as WEAK/WATCH even for its strongest names.
  UPDATE public.market_score_history h
  SET band = CASE
        WHEN h.score >= d.strong_cut   THEN 'strong'
        WHEN h.score >= d.moderate_cut THEN 'moderate'
        WHEN h.score >= d.watch_cut    THEN 'watch'
        ELSE 'weak' END
  FROM public.market_score_distribution d
  WHERE d.trade_date = h.trade_date AND d.model = h.model
    AND h.model = _model AND h.score IS NOT NULL
    AND d.strong_cut IS NOT NULL
    AND h.band IS DISTINCT FROM (CASE
        WHEN h.score >= d.strong_cut   THEN 'strong'
        WHEN h.score >= d.moderate_cut THEN 'moderate'
        WHEN h.score >= d.watch_cut    THEN 'watch'
        ELSE 'weak' END);

  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_score_history_ranks(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stamp_score_history_ranks(text) TO service_role;