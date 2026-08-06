CREATE OR REPLACE VIEW public.market_screener_live AS
WITH latest_shares AS (
  SELECT DISTINCT ON (m.symbol) m.symbol, m.total_shares, m.as_of, m.source AS shares_source
  FROM market_shares_outstanding m
  ORDER BY m.symbol, m.as_of DESC
), consensus AS (
  SELECT mc.symbol, mc.exchange,
    max(mc.value) FILTER (WHERE mc.metric = 'market_cap') AS consensus_market_cap,
    max(mc.source_provider) FILTER (WHERE mc.metric = 'market_cap') AS consensus_market_cap_provider,
    max(mc.source_method) FILTER (WHERE mc.metric = 'market_cap') AS consensus_market_cap_method,
    max(mc.confidence) FILTER (WHERE mc.metric = 'market_cap') AS consensus_market_cap_confidence,
    max(mc.status) FILTER (WHERE mc.metric = 'market_cap') AS consensus_market_cap_status,
    max(mc.delta_pct) FILTER (WHERE mc.metric = 'market_cap') AS consensus_market_cap_delta_pct,
    max(mc.computed_at) FILTER (WHERE mc.metric = 'market_cap') AS consensus_market_cap_as_of
  FROM market_metric_consensus mc
  WHERE mc.metric = 'market_cap'
  GROUP BY mc.symbol, mc.exchange
)
SELECT s.symbol,
  s.exchange,
  s.company_name,
  COALESCE(f.sector, s.sector, sc.sector) AS sector,
  COALESCE(s.sub_sector, sm_i.sub_sector, sm_b.sub_sector, f.industry, s.industry) AS sub_sector,
  COALESCE(f.industry, s.industry) AS industry,
  COALESCE(f.market_cap_cr, s.market_cap) AS market_cap_reported,
  CASE
    WHEN c.consensus_market_cap IS NOT NULL THEN round(c.consensus_market_cap, 2)
    WHEN ls.total_shares IS NOT NULL AND en.close IS NOT NULL AND en.close > 0 THEN round(ls.total_shares * en.close / 10000000::numeric, 2)
    WHEN f.market_cap_cr IS NOT NULL AND f.price IS NOT NULL AND f.price > 0 AND en.close IS NOT NULL AND en.close > 0 THEN round(f.market_cap_cr * (en.close / f.price), 2)
    ELSE COALESCE(f.market_cap_cr, s.market_cap)
  END AS market_cap,
  s.is_nifty500,
  s.in_universe,
  s.is_active,
  COALESCE(s.instrument_type, 'EQ') AS instrument_type,
  s.yahoo_symbol,
  s.last_price_sync_at,
  s.last_fundamentals_sync_at,
  (EXISTS (SELECT 1 FROM market_stocks x
            WHERE x.symbol = s.symbol AND x.is_active = true
              AND x.instrument_type = ANY (ARRAY['FUT','OPT','FUTIDX','OPTIDX','FUTSTK','OPTSTK']))) AS fno_enabled,
  COALESCE(s.series = ANY (ARRAY['BE','BZ','SM','ST','SME']), false) AS sme,
  sc.id AS score_id,
  en.trade_date AS trade_date,
  en.close AS close,
  CASE WHEN en.close IS NOT NULL AND en.prev_close IS NOT NULL THEN round(en.close - en.prev_close, 2) END AS change_abs,
  CASE WHEN en.close IS NOT NULL AND en.prev_close IS NOT NULL AND en.prev_close > 0
       THEN round((en.close - en.prev_close) / en.prev_close * 100::numeric, 2) END AS change_pct,
  CASE WHEN en.close IS NOT NULL AND en.prev_close IS NOT NULL AND en.prev_close > 0
       THEN (en.close - en.prev_close) / en.prev_close * 100::numeric END AS change_pct_raw,
  en.volume AS volume,
  en.prev_close AS previous_close,
  sc.close_adjusted,
  sc.vol_avg20,
  sc.vol_avg30,
  sc.rel_volume,
  CASE WHEN en.volume IS NULL OR sc.vol_avg30 IS NULL OR sc.vol_avg30 <= 0::numeric
       THEN NULL::boolean ELSE en.volume::numeric > sc.vol_avg30 END AS vol_gt_avg30,
  sc.ema20, sc.ema50, sc.ema100, sc.ema200,
  sc.rsi14, sc.macd, sc.macd_signal, sc.macd_hist,
  sc.adx14, sc.atr14, sc.atr_pct,
  sc.bb_upper, sc.bb_lower, sc.bb_width, sc.bb_squeeze,
  sc.high_52w, sc.low_52w, sc.pct_from_52w_high, sc.above_ema200,
  sc.higher_lows, sc.near_resistance, sc.resistance_level, sc.support_level,
  sc.sector_strength, sc.rel_strength_nifty,
  sc.breakout_score, sc.prebreakout_score, sc.score_components, sc.computed_at,
  sc.ret_5d, sc.ret_21d, sc.ret_ytd,
  f.price AS fundamental_price,
  f.pe_ttm, f.pb, f.peg, f.eps_ttm, f.book_value, f.dividend_yield,
  f.roe, f.roce, f.debt_to_equity, f.current_ratio, f.quick_ratio,
  f.revenue_ttm_cr, f.profit_ttm_cr, f.revenue_growth_yoy, f.profit_growth_yoy, f.eps_growth_yoy,
  f.promoter_holding, f.promoter_pledge, f.fii_holding, f.dii_holding, f.face_value,
  f.high_52w AS fundamental_high_52w,
  f.low_52w AS fundamental_low_52w,
  f.sync_source, f.sync_status, f.last_error, f.data_as_of, f.last_attempted_at,
  f.updated_at AS fundamentals_updated_at,
  jsonb_build_object(
    'close', en.src,
    'close_as_of', en.trade_date,
    'volume', en.src,
    'mcap', CASE
      WHEN c.consensus_market_cap IS NOT NULL THEN 'consensus'
      WHEN ls.total_shares IS NOT NULL AND en.close IS NOT NULL THEN 'shares_x_close'
      WHEN f.market_cap_cr IS NOT NULL AND en.close IS NOT NULL THEN 'fmp_repriced'
      ELSE 'fmp_raw' END,
    'mcap_provider', c.consensus_market_cap_provider,
    'mcap_method', c.consensus_market_cap_method,
    'mcap_confidence', c.consensus_market_cap_confidence,
    'mcap_status', c.consensus_market_cap_status,
    'mcap_delta_pct', c.consensus_market_cap_delta_pct,
    'mcap_as_of', c.consensus_market_cap_as_of,
    'shares_source', ls.shares_source,
    'shares_as_of', ls.as_of,
    'nse_trade_date', en.trade_date,
    'change_pct_source', en.src,
    'pe_source', COALESCE(f.pe_source, f.sync_source),
    'pe_as_of', COALESCE(f.pe_as_of, f.updated_at),
    'roe_source', COALESCE(f.roe_source, f.sync_source),
    'roe_as_of', COALESCE(f.roe_as_of, f.updated_at),
    'de_source', COALESCE(f.de_source, f.sync_source),
    'de_as_of', COALESCE(f.de_as_of, f.updated_at),
    'sub_sector_source', COALESCE(s.sub_sector_source, sm_i.source, sm_b.source, 'derived')
  ) AS data_provenance,
  (en.close IS NOT NULL AND en.volume IS NOT NULL
    AND (c.consensus_market_cap IS NOT NULL AND c.consensus_market_cap_status = ANY (ARRAY['ok','estimated'])
         OR ls.total_shares IS NOT NULL AND ls.as_of >= (CURRENT_DATE - '3 days'::interval))) AS strict_ok,
  sc.trade_date AS score_trade_date,
  sc.is_liquid_tradable,
  sc.liquidity_reasons,
  sc.swing_score,
  sc.intraday_score
FROM market_stocks s
LEFT JOIN LATERAL (
  SELECT u.trade_date, u.close, u.volume, u.prev_close, u.src
  FROM (
    (SELECT p.trade_date,
            COALESCE(p.close_adjusted, p.close) AS close,
            p.volume,
            (SELECT COALESCE(q.close_adjusted, q.close)
               FROM market_daily_prices q
              WHERE q.symbol = p.symbol AND q.exchange = p.exchange AND q.trade_date < p.trade_date
                AND COALESCE(q.close_adjusted, q.close) IS NOT NULL
              ORDER BY q.trade_date DESC LIMIT 1) AS prev_close,
            'daily_prices'::text AS src,
            1 AS pri
       FROM market_daily_prices p
      WHERE p.symbol = s.symbol AND p.exchange = s.exchange
        AND COALESCE(p.close_adjusted, p.close) IS NOT NULL
      ORDER BY p.trade_date DESC LIMIT 1)
    UNION ALL
    (SELECT e.trade_date, e.close, e.volume, e.prev_close, 'nse_bhavcopy'::text, 2
       FROM market_eod_nse e
      WHERE e.symbol = s.symbol AND e.exchange = s.exchange AND e.close IS NOT NULL
      ORDER BY e.trade_date DESC LIMIT 1)
  ) u
  ORDER BY u.pri
  LIMIT 1
) en ON true
LEFT JOIN LATERAL (
  SELECT z.* FROM market_stock_scores z
   WHERE z.symbol = s.symbol AND z.exchange = s.exchange
   ORDER BY z.trade_date DESC LIMIT 1
) sc ON true
LEFT JOIN market_fundamentals_global f ON f.symbol = s.symbol AND f.exchange = s.exchange
LEFT JOIN latest_shares ls ON ls.symbol = s.symbol
LEFT JOIN consensus c ON c.symbol = s.symbol AND c.exchange = s.exchange
LEFT JOIN market_sector_map sm_i ON sm_i.nse_sector = COALESCE(f.sector, s.sector) AND sm_i.industry = COALESCE(f.industry, s.industry, '')
LEFT JOIN market_sector_map sm_b ON sm_b.nse_sector = COALESCE(f.sector, s.sector) AND sm_b.industry = ''
WHERE s.is_active = true
  AND NOT COALESCE(s.penny_excluded, false);

ALTER VIEW public.market_screener_live SET (security_invoker = on);

GRANT SELECT ON public.market_screener_live TO anon, authenticated;
GRANT ALL ON public.market_screener_live TO service_role;

-- Shape assertion: refresh_market_screener_snapshot() does INSERT ... SELECT *,
-- so the view's column list must line up with the snapshot table (which has one
-- extra trailing column, refreshed_at, supplied by the function).
DO $$
DECLARE v_cols text; t_cols text;
BEGIN
  SELECT string_agg(column_name, ',' ORDER BY ordinal_position) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='market_screener_live';
  SELECT string_agg(column_name, ',' ORDER BY ordinal_position) INTO t_cols
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='market_screener_snapshot'
     AND column_name <> 'refreshed_at';
  IF v_cols <> t_cols THEN
    RAISE EXCEPTION 'screener view/snapshot column mismatch';
  END IF;
END $$;

SELECT public.refresh_market_screener_snapshot();