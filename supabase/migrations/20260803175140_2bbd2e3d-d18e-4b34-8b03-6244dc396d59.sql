DO $backfill$
DECLARE
  r record;
  cursor_symbol text := NULL;
  processed_n integer := 0;
  batch_no integer := 0;
BEGIN
  SELECT * INTO r FROM public.promote_market_eod_session('2026-08-03');
  RAISE NOTICE 'promoted session %, source %, eligible %, rows %, remaining %',
    r.session_date, r.source_rows, r.eligible_rows, r.promoted_rows, r.remaining_gap;

  LOOP
    SELECT * INTO r
    FROM public.market_rescore_prices_batch('2026-08-03', 400, cursor_symbol);
    EXIT WHEN COALESCE(r.processed, 0) = 0 OR r.last_symbol IS NULL;
    processed_n := processed_n + r.processed;
    cursor_symbol := r.last_symbol;
    batch_no := batch_no + 1;
    EXIT WHEN batch_no >= 12;
  END LOOP;

  RAISE NOTICE 'rescored % symbols through %', processed_n, cursor_symbol;
END;
$backfill$;