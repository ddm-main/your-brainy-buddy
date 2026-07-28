-- 1. anon exposure of fundamentals
DROP POLICY IF EXISTS "read global fundamentals" ON public.market_fundamentals_global;
CREATE POLICY "read global fundamentals" ON public.market_fundamentals_global
  FOR SELECT TO authenticated USING (true);
REVOKE SELECT ON public.market_fundamentals_global FROM anon;

-- 2. internal/proprietary market tables -> admin only
DROP POLICY IF EXISTS "read market metric consensus" ON public.market_metric_consensus;
CREATE POLICY "read market metric consensus" ON public.market_metric_consensus
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
REVOKE SELECT ON public.market_metric_consensus FROM anon;

DROP POLICY IF EXISTS "calibration readable by authenticated" ON public.market_scoring_calibration;
CREATE POLICY "calibration readable by admins" ON public.market_scoring_calibration
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
REVOKE SELECT ON public.market_scoring_calibration FROM anon;

DROP POLICY IF EXISTS "audit read for authed" ON public.market_value_audit;
CREATE POLICY "audit read for admins" ON public.market_value_audit
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
REVOKE SELECT ON public.market_value_audit FROM anon;

-- 3. realtime-published watchlists: scope policies to authenticated role explicitly
DROP POLICY IF EXISTS "own market_watchlists" ON public.market_watchlists;
CREATE POLICY "own market_watchlists" ON public.market_watchlists
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
REVOKE ALL ON public.market_watchlists FROM anon;

DROP POLICY IF EXISTS "own market_watchlist_items" ON public.market_watchlist_items;
CREATE POLICY "own market_watchlist_items" ON public.market_watchlist_items
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
REVOKE ALL ON public.market_watchlist_items FROM anon;

-- 4. default owner = auth.uid() on user-owned tables
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'budgets','category_rules','detection_runs','finance_alerts','finance_reports','finance_suggestions',
    'gmail_sync_runs','holding_transactions','holdings','insurance_policies','market_alert_events','market_alerts',
    'market_api_settings','market_autotrade_log','market_autotrade_orders','market_autotrade_rules',
    'market_autotrade_settings','market_backtest_results','market_fundamentals','market_funds','market_gtt_orders',
    'market_holdings','market_index_watch','market_option_chain_snapshots','market_order_intents',
    'market_portfolio_notes','market_positions','market_realized_pnl_daily','market_saved_screeners',
    'market_saved_strategies','market_screener_favorites','market_stock_ai','market_user_prefs',
    'market_watchlist_items','market_watchlists','merchant_aliases','push_subscriptions','statement_skeletons',
    'tax_entries','threads'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN user_id SET DEFAULT auth.uid()', t);
  END LOOP;
END $$;

-- 5. revoke execute on internal trigger function from public/anon/authenticated
REVOKE ALL ON FUNCTION public.guard_market_api_settings_is_system() FROM PUBLIC, anon, authenticated;