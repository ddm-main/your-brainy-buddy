-- Prepayments are modeled as ordinary transactions rows tagged loan_id —
-- same precedent as existing EMI-payment logging (Loans.tsx's "log EMI
-- payment") — distinguished by this explicit flag rather than an
-- amount-over-EMI heuristic, which would false-positive on irregular EMI
-- schedules or partial months.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS is_prepayment boolean NOT NULL DEFAULT false;

-- No RLS change needed — transactions is already owner-scoped hardened.
