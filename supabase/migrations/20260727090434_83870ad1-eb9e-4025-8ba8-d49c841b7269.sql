-- Shared system-feed tick channel. The Kotak WS relay is bound to the
-- designated system feed (market_api_settings.is_system = true), so ticks
-- are the same for every signed-in user. Previously the relay broadcast on
-- `market-ticks-<feedOwnerUserId>` while each client subscribed to
-- `market-ticks-<theirOwnUserId>` — so only the feed-owner account ever
-- received push ticks and every other user silently fell back to REST.
-- New shared topic: `market-ticks-system`. Any authenticated user may
-- receive; only service_role (relay) writes (service_role bypasses RLS).
DROP POLICY IF EXISTS "receive shared market ticks" ON realtime.messages;
CREATE POLICY "receive shared market ticks" ON realtime.messages
  FOR SELECT TO authenticated
  USING (realtime.topic() = 'market-ticks-system');
