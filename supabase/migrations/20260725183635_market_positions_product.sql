-- market_positions had no `product` column at all, so ConvertPositionModal
-- could never know a broker-synced position's real product (MIS/CNC/NRML)
-- and always defaulted its "From" selector to MIS regardless of what the
-- position actually was.
ALTER TABLE public.market_positions ADD COLUMN product text CHECK (product IS NULL OR product IN ('MIS', 'CNC', 'NRML'));
