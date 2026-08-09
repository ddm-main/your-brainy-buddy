DROP POLICY IF EXISTS "receive own market ticks" ON realtime.messages;
CREATE POLICY "receive own market ticks" ON realtime.messages
  FOR SELECT TO authenticated
  USING (realtime.topic() = 'market-ticks-' || auth.uid()::text);

DROP POLICY IF EXISTS "broadcast on own market ticks channel" ON realtime.messages;
CREATE POLICY "broadcast on own market ticks channel" ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (realtime.topic() = 'market-ticks-' || auth.uid()::text);

DROP POLICY IF EXISTS "receive shared market ticks" ON realtime.messages;
CREATE POLICY "receive shared market ticks" ON realtime.messages
  FOR SELECT TO authenticated
  USING (realtime.topic() = 'market-ticks-system');