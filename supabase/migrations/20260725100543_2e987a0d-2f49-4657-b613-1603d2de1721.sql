DROP POLICY IF EXISTS "Service role can manage market provider health" ON public.market_provider_health;
CREATE POLICY "Service role can manage market provider health"
  ON public.market_provider_health
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);