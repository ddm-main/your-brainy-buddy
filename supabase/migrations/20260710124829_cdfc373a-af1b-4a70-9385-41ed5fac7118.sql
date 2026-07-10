
ALTER TABLE public.email_accounts
  ADD COLUMN IF NOT EXISTS sync_frequency text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS sync_period_days integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS use_case text NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS finance_only boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS finance_sender_filter text,
  ADD COLUMN IF NOT EXISTS permission_level text NOT NULL DEFAULT 'read',
  ADD COLUMN IF NOT EXISTS auto_categorize boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_on_new boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_per_sync integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS paused_at timestamptz;

-- Validation constraints (tolerant / non-blocking)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_accounts_sync_frequency_chk') THEN
    ALTER TABLE public.email_accounts ADD CONSTRAINT email_accounts_sync_frequency_chk
      CHECK (sync_frequency IN ('manual','15m','hourly','6h','daily'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_accounts_use_case_chk') THEN
    ALTER TABLE public.email_accounts ADD CONSTRAINT email_accounts_use_case_chk
      CHECK (use_case IN ('general','finance','work','personal'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_accounts_permission_level_chk') THEN
    ALTER TABLE public.email_accounts ADD CONSTRAINT email_accounts_permission_level_chk
      CHECK (permission_level IN ('read','read_write'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_accounts_period_chk') THEN
    ALTER TABLE public.email_accounts ADD CONSTRAINT email_accounts_period_chk
      CHECK (sync_period_days BETWEEN 1 AND 365);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_accounts_max_per_sync_chk') THEN
    ALTER TABLE public.email_accounts ADD CONSTRAINT email_accounts_max_per_sync_chk
      CHECK (max_per_sync BETWEEN 1 AND 500);
  END IF;
END $$;
