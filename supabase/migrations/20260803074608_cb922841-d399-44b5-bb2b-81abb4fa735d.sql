-- Backfill: market_intraday_prices.volume currently holds the RUNNING DAY TOTAL
-- for quote-snapshot sources (kotak_quote, yahoo_delayed). Convert to per-bar
-- volume, preserving the original figure in cum_volume so it stays recomputable.
WITH scoped AS (
  SELECT
    id, symbol, exchange, timeframe, ts, source,
    volume,
    (ts + interval '5 hours 30 minutes')::date AS ist_day,
    LAG(volume) OVER (
      PARTITION BY symbol, exchange, timeframe, source, (ts + interval '5 hours 30 minutes')::date
      ORDER BY ts
    ) AS prev_volume,
    COUNT(*) OVER (
      PARTITION BY symbol, exchange, timeframe, source, (ts + interval '5 hours 30 minutes')::date
    ) AS bars_in_session
  FROM public.market_intraday_prices
  WHERE ts >= now() - interval '8 days'
),
stats AS (
  -- A session is cumulative when nearly every step is non-decreasing.
  SELECT
    symbol, exchange, timeframe, source, ist_day,
    AVG(CASE WHEN prev_volume IS NULL THEN NULL
             WHEN volume >= prev_volume THEN 1.0 ELSE 0.0 END) AS monotonic_ratio,
    MAX(bars_in_session) AS bars_in_session
  FROM scoped
  GROUP BY symbol, exchange, timeframe, source, ist_day
),
cumulative_sessions AS (
  SELECT symbol, exchange, timeframe, source, ist_day
  FROM stats
  WHERE bars_in_session >= 4 AND monotonic_ratio >= 0.85
),
medians AS (
  -- Typical per-bar delta per session, used to cap the first recorded bar.
  SELECT s.symbol, s.exchange, s.timeframe, s.source, s.ist_day,
         PERCENTILE_CONT(0.5) WITHIN GROUP (
           ORDER BY GREATEST(s.volume - s.prev_volume, 0)
         ) AS median_delta
  FROM scoped s
  JOIN cumulative_sessions c USING (symbol, exchange, timeframe, source, ist_day)
  WHERE s.prev_volume IS NOT NULL AND s.volume >= s.prev_volume
  GROUP BY s.symbol, s.exchange, s.timeframe, s.source, s.ist_day
),
fixed AS (
  SELECT
    s.id,
    s.volume AS original_volume,
    CASE
      WHEN s.prev_volume IS NULL
        THEN LEAST(s.volume, COALESCE(m.median_delta, s.volume))
      WHEN s.volume >= s.prev_volume
        THEN s.volume - s.prev_volume
      -- A drop means the counter restarted: this value IS its own delta.
      ELSE s.volume
    END AS per_bar_volume
  FROM scoped s
  JOIN cumulative_sessions c USING (symbol, exchange, timeframe, source, ist_day)
  LEFT JOIN medians m USING (symbol, exchange, timeframe, source, ist_day)
)
UPDATE public.market_intraday_prices p
SET cum_volume = COALESCE(p.cum_volume, f.original_volume),
    volume = GREATEST(ROUND(f.per_bar_volume)::bigint, 0)
FROM fixed f
WHERE p.id = f.id;