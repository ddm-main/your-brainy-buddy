-- Revoke EXECUTE from anon/authenticated/public on SECURITY DEFINER helpers
-- that should never be callable via PostgREST. Trigger functions and
-- cron/admin helpers do not need to be exposed to end users.
-- has_role / has_section_access are intentionally left executable because
-- RLS policy expressions depend on them.

REVOKE EXECUTE ON FUNCTION public.assign_default_role_and_access() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.block_new_signups() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.market_index_watch_set_sort() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.market_index_watch_repack() FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.purge_old_jarvis_interactions() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_old_ticker_trace() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_market_top_movers() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.seed_default_indices(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.market_cron_call(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.verify_market_cron_secret(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_market_fundamentals_sync(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.market_history_backfill_candidates(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.market_asof_candles(date, text[], integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_jarvis_usage(uuid, integer, bigint, text) FROM PUBLIC, anon, authenticated;
