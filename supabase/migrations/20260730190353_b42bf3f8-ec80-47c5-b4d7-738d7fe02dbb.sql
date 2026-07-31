GRANT SELECT ON public.market_provider_health TO authenticated;

CREATE POLICY "Signed-in users can read provider health"
ON public.market_provider_health
FOR SELECT
TO authenticated
USING (true);