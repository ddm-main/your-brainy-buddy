-- ============================================================================
-- Bank/credit-card statement PDF ingestion: password storage, attachment
-- linkage, extracted-summary columns, and a private Storage bucket for the
-- original PDFs. Every altered/new table keeps the existing "owner rw"
-- (auth.uid() = user_id) RLS posture from the 2026-07-10 hardening pass —
-- see 20260710082821_7eaad151-6440-45c2-9664-5aede65ca294.sql for the
-- pattern this migration deliberately does not deviate from.
-- ============================================================================

-- financial_accounts gets the same encrypted-password slot credit_cards
-- already has. Table is already hardened (user_id + "owner rw"), so no RLS
-- change is needed here.
ALTER TABLE public.financial_accounts
  ADD COLUMN IF NOT EXISTS statement_password_rule jsonb;

-- statement_password_rule shape (both financial_accounts and credit_cards),
-- written only by the finance-set-statement-password edge function via
-- AES-256-GCM (see supabase/functions/_shared/crypto.ts):
--   { v: 1, alg: "aes-256-gcm", ciphertext_b64, iv_b64, auth_tag_b64, encrypted_at }
-- Never store plaintext or a hint here.

-- email_attachments already exists (created in
-- 20260709130451_f5b431a6-4ea7-403f-afb8-ec253c7e868b.sql, hardened in
-- 20260710082821). Add statement linkage + size tracking.
ALTER TABLE public.email_attachments
  ADD COLUMN IF NOT EXISTS statement_id uuid REFERENCES public.statements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS byte_size int;

CREATE INDEX IF NOT EXISTS email_attachments_statement_idx ON public.email_attachments(statement_id);

-- statements gains extracted summary fields the PDF parser fills in —
-- period_start/period_end/file_path/parse_status already existed and were
-- unused; total_due/closing_balance/due_date are new.
ALTER TABLE public.statements
  ADD COLUMN IF NOT EXISTS total_due numeric,
  ADD COLUMN IF NOT EXISTS closing_balance numeric,
  ADD COLUMN IF NOT EXISTS due_date date;

-- ============================================================================
-- Storage: private bucket for the original statement PDFs. All writes go
-- through the finance-extract edge function's service-role client (bypasses
-- RLS entirely, same as jarvis-vision-upload); the owner-scoped policies
-- below are defense-in-depth for any future direct-from-browser access.
-- Mirrors the jarvis-vision bucket policy block in 20260710082821 verbatim,
-- renamed to statement-pdfs.
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('statement-pdfs', 'statement-pdfs', false)
on conflict (id) do nothing;

DROP POLICY IF EXISTS "statement-pdfs owner read"   ON storage.objects;
DROP POLICY IF EXISTS "statement-pdfs owner write"  ON storage.objects;
DROP POLICY IF EXISTS "statement-pdfs owner update" ON storage.objects;
DROP POLICY IF EXISTS "statement-pdfs owner delete" ON storage.objects;

CREATE POLICY "statement-pdfs owner read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'statement-pdfs' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "statement-pdfs owner write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'statement-pdfs' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "statement-pdfs owner update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'statement-pdfs' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "statement-pdfs owner delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'statement-pdfs' AND (storage.foldername(name))[1] = auth.uid()::text);
