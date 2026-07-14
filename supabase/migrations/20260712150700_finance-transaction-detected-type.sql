-- Additive column for enhanced transaction auto-detection (salary/sip/emi/
-- dividend/insurance_premium/interest/refund/transfer) — same precedent as
-- is_prepayment. Nullable: undetected/manual transactions are unaffected.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS detected_type text CHECK (detected_type IN (
    'salary','sip','emi','dividend','insurance_premium','interest','refund','transfer'
  ));

-- No RLS change needed — transactions is already owner-scoped hardened.
