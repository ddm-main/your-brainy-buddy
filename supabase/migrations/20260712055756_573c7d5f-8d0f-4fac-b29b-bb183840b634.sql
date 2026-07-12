
ALTER TABLE public.statements
  ADD COLUMN IF NOT EXISTS parse_error text,
  ADD COLUMN IF NOT EXISTS content_sha256 text;

CREATE UNIQUE INDEX IF NOT EXISTS statements_user_sha_unique
  ON public.statements (user_id, content_sha256)
  WHERE content_sha256 IS NOT NULL;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS payment_mode text;

-- storage.objects RLS for the private statement-pdfs bucket, mirroring jarvis-vision.
CREATE POLICY "statement-pdfs owner read"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'statement-pdfs' AND (storage.foldername(name))[1] = (auth.uid())::text);

CREATE POLICY "statement-pdfs owner write"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'statement-pdfs' AND (storage.foldername(name))[1] = (auth.uid())::text);

CREATE POLICY "statement-pdfs owner update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'statement-pdfs' AND (storage.foldername(name))[1] = (auth.uid())::text)
  WITH CHECK (bucket_id = 'statement-pdfs' AND (storage.foldername(name))[1] = (auth.uid())::text);

CREATE POLICY "statement-pdfs owner delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'statement-pdfs' AND (storage.foldername(name))[1] = (auth.uid())::text);
