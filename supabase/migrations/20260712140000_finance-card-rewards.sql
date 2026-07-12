-- Minimal card rewards/cashback tracking. Deliberately lean — a personal
-- finance app doesn't need a per-merchant multiplier engine, just enough to
-- see "this card gives me X% back/points" at a glance on the card detail page.

ALTER TABLE public.credit_cards
  ADD COLUMN IF NOT EXISTS reward_type text,
  ADD COLUMN IF NOT EXISTS reward_rate_pct numeric(5,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'credit_cards_reward_type_check'
  ) THEN
    ALTER TABLE public.credit_cards
      ADD CONSTRAINT credit_cards_reward_type_check
      CHECK (reward_type IS NULL OR reward_type IN ('cashback','points','miles'));
  END IF;
END $$;

-- No RLS change needed — credit_cards is already owner-scoped hardened.
