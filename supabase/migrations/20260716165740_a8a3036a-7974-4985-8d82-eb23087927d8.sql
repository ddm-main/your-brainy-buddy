
-- Wave 0: force PostgREST to re-introspect statements (fixes stale schema cache
-- that keeps rejecting the extracted_text column and stamping statement_update_failed).
NOTIFY pgrst, 'reload schema';

-- Wave A: reconcile manual_fields.card_last4 with the linked card and reset
-- rows failed only by the schema-cache issue. Transactions untouched.
UPDATE public.statements s
SET manual_fields = jsonb_set(
      coalesce(s.manual_fields, '{}'::jsonb),
      '{card_last4}',
      to_jsonb(right(regexp_replace(c.masked_number, '\D', '', 'g'), 4)),
      true
    ),
    parse_status = CASE
      WHEN s.parse_error = 'statement_update_failed'
        OR coalesce(s.parse_reason, '') ILIKE '%extracted_text%'
        OR coalesce(s.parse_reason, '') ILIKE '%schema cache%'
      THEN 'pending'::parse_status
      ELSE s.parse_status
    END,
    parse_error = CASE
      WHEN s.parse_error = 'statement_update_failed'
        OR coalesce(s.parse_reason, '') ILIKE '%extracted_text%'
        OR coalesce(s.parse_reason, '') ILIKE '%schema cache%'
      THEN NULL
      ELSE s.parse_error
    END,
    parse_reason = CASE
      WHEN s.parse_error = 'statement_update_failed'
        OR coalesce(s.parse_reason, '') ILIKE '%extracted_text%'
        OR coalesce(s.parse_reason, '') ILIKE '%schema cache%'
      THEN NULL
      ELSE s.parse_reason
    END,
    learn_attempts = CASE
      WHEN s.parse_error = 'statement_update_failed'
        OR coalesce(s.parse_reason, '') ILIKE '%extracted_text%'
        OR coalesce(s.parse_reason, '') ILIKE '%schema cache%'
      THEN 0
      ELSE s.learn_attempts
    END,
    last_learn_at = CASE
      WHEN s.parse_error = 'statement_update_failed'
        OR coalesce(s.parse_reason, '') ILIKE '%extracted_text%'
        OR coalesce(s.parse_reason, '') ILIKE '%schema cache%'
      THEN NULL
      ELSE s.last_learn_at
    END
FROM public.credit_cards c
WHERE s.credit_card_id = c.id
  AND length(regexp_replace(coalesce(c.masked_number, ''), '\D', '', 'g')) >= 4
  AND (
    coalesce(s.manual_fields->>'card_last4', '') <> right(regexp_replace(c.masked_number, '\D', '', 'g'), 4)
    OR s.parse_error = 'statement_update_failed'
    OR coalesce(s.parse_reason, '') ILIKE '%extracted_text%'
    OR coalesce(s.parse_reason, '') ILIKE '%schema cache%'
  );

-- Also reset any remaining rows failed by schema-cache but not linked to a card,
-- so the retry pipeline can pick them up cleanly.
UPDATE public.statements
SET parse_status = 'pending'::parse_status,
    parse_error = NULL,
    parse_reason = NULL,
    learn_attempts = 0,
    last_learn_at = NULL
WHERE parse_error = 'statement_update_failed'
   OR coalesce(parse_reason, '') ILIKE '%extracted_text%'
   OR coalesce(parse_reason, '') ILIKE '%schema cache%';

-- Reload again post-updates so PostgREST picks up any dependency changes.
NOTIFY pgrst, 'reload schema';
