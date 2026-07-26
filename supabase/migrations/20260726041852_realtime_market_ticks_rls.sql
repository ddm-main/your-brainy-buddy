-- Realtime Authorization policies for the private `market-ticks-<user_id>`
-- broadcast channel (Apps/relay/kotak-ws-relay.mjs pushes ticks; the client
-- subscribes and also broadcasts a `subscribe` event with its on-screen
-- symbol set — see src/lib/market/useRealtimeTicks.ts). No policy for this
-- channel existed anywhere in migrations — if one exists at all today it
-- only lives in dashboard config, unreproducible and unauditable as code.
-- Scopes both directions to the caller's own channel: a user can only
-- receive ticks on, or broadcast onto, `market-ticks-<their own auth.uid()>`.
DROP POLICY IF EXISTS "receive own market ticks" ON realtime.messages;
CREATE POLICY "receive own market ticks" ON realtime.messages
  FOR SELECT TO authenticated
  USING (realtime.topic() = 'market-ticks-' || auth.uid()::text);

DROP POLICY IF EXISTS "broadcast on own market ticks channel" ON realtime.messages;
CREATE POLICY "broadcast on own market ticks channel" ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (realtime.topic() = 'market-ticks-' || auth.uid()::text);
