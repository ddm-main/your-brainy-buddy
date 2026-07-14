
-- 1. Backfill file_path from stored attachments
UPDATE public.statements AS s
SET file_path = latest.storage_path, updated_at = now()
FROM (
  SELECT DISTINCT ON (statement_id) statement_id, storage_path
  FROM public.email_attachments
  WHERE statement_id IS NOT NULL AND storage_path IS NOT NULL
  ORDER BY statement_id, created_at DESC
) latest
WHERE s.id = latest.statement_id AND s.file_path IS NULL;

-- 2. Unstick attachments incorrectly marked 'parsed' while parent isn't
UPDATE public.email_attachments ea
SET parse_status = 'pending'
FROM public.statements s
WHERE ea.statement_id = s.id
  AND ea.parse_status = 'parsed'
  AND s.parse_status IN ('pending','failed','skipped');

-- 3. Backfill missing statement_date from source email received_at
UPDATE public.statements s
SET statement_date = e.received_at::date,
    updated_at = now()
FROM public.emails e
WHERE s.source_email_id = e.id
  AND s.statement_date IS NULL;

-- 4. Allow reparse to touch statements previously marked 'skipped'
UPDATE public.statements
SET parse_status = 'pending', parse_error = NULL, parse_reason = NULL, updated_at = now()
WHERE parse_status = 'skipped'
  AND source_email_id IS NOT NULL;
