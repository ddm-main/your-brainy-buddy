
ALTER TABLE public.email_accounts
  ADD COLUMN IF NOT EXISTS google_sub text,
  ADD COLUMN IF NOT EXISTS access_token text,
  ADD COLUMN IF NOT EXISTS refresh_token text,
  ADD COLUMN IF NOT EXISTS token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS scopes text,
  ADD COLUMN IF NOT EXISTS connected_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS history_id text;

CREATE UNIQUE INDEX IF NOT EXISTS email_accounts_user_google_sub_uniq
  ON public.email_accounts(user_id, google_sub) WHERE google_sub IS NOT NULL;

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS snippet text,
  ADD COLUMN IF NOT EXISTS provider text;

CREATE UNIQUE INDEX IF NOT EXISTS emails_user_external_uniq
  ON public.emails(user_id, account_id, external_email_id) WHERE external_email_id IS NOT NULL;
