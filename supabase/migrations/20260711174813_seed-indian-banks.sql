-- ============================================================================
-- Seed public.banks with the major Indian banks so the Bank picker in
-- Config -> Accounts/Cards has real options instead of "no options" on a
-- fresh project. A case-insensitive (user_id, lower(name)) unique index is
-- added so this seed — and any future manual "or new bank" entry — can't
-- create dupes.
--
-- The live table already has duplicate names (e.g. three "SBI" rows, created
-- before this constraint existed) — dedup those first: keep the
-- earliest-created row per (user_id, lower(name)), repoint any
-- financial_accounts/credit_cards referencing a duplicate onto the keeper,
-- then delete the duplicates. Otherwise the unique index creation below
-- would fail against the existing dupes.
--
-- Owner uid matches the single-user posture set in
-- 20260710082821_7eaad151-6440-45c2-9664-5aede65ca294.sql.
-- ============================================================================

DO $$
DECLARE
  r RECORD;
  keeper uuid;
  dupes uuid[];
BEGIN
  FOR r IN
    SELECT user_id, lower(trim(name)) AS norm_name, array_agg(id ORDER BY created_at) AS ids
    FROM public.banks
    GROUP BY user_id, lower(trim(name))
    HAVING count(*) > 1
  LOOP
    keeper := r.ids[1];
    dupes := r.ids[2:array_length(r.ids, 1)];
    UPDATE public.financial_accounts SET bank_id = keeper WHERE bank_id = ANY(dupes);
    UPDATE public.credit_cards SET bank_id = keeper WHERE bank_id = ANY(dupes);
    DELETE FROM public.banks WHERE id = ANY(dupes);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS banks_user_id_lower_name_key ON public.banks (user_id, lower(name));

DO $$
DECLARE
  owner_uid uuid := '2ff4497a-dedc-4885-98e5-435b26894275';
  bank_names text[] := ARRAY[
    -- Public sector banks
    'State Bank of India', 'Punjab National Bank', 'Bank of Baroda', 'Canara Bank',
    'Union Bank of India', 'Bank of India', 'Indian Bank', 'Central Bank of India',
    'Indian Overseas Bank', 'UCO Bank', 'Bank of Maharashtra', 'Punjab & Sind Bank',

    -- Private sector banks
    'HDFC Bank', 'ICICI Bank', 'Axis Bank', 'Kotak Mahindra Bank', 'IndusInd Bank',
    'Yes Bank', 'IDFC First Bank', 'Federal Bank', 'South Indian Bank', 'RBL Bank',
    'Karur Vysya Bank', 'City Union Bank', 'DCB Bank', 'Bandhan Bank', 'CSB Bank',
    'Tamilnad Mercantile Bank', 'Dhanlaxmi Bank', 'Jammu & Kashmir Bank',
    'Karnataka Bank', 'Nainital Bank',

    -- Foreign banks operating in India
    'Citibank', 'HSBC', 'Standard Chartered Bank', 'Deutsche Bank',
    'DBS Bank India', 'Bank of America',

    -- Small finance banks
    'AU Small Finance Bank', 'Equitas Small Finance Bank', 'Ujjivan Small Finance Bank',
    'ESAF Small Finance Bank', 'Suryoday Small Finance Bank', 'Jana Small Finance Bank',
    'Utkarsh Small Finance Bank', 'North East Small Finance Bank',
    'Shivalik Small Finance Bank', 'Unity Small Finance Bank',

    -- Payments banks
    'Airtel Payments Bank', 'India Post Payments Bank', 'Fino Payments Bank',
    'Jio Payments Bank', 'NSDL Payments Bank'
  ];
  bank_name text;
BEGIN
  FOREACH bank_name IN ARRAY bank_names LOOP
    INSERT INTO public.banks (name, user_id)
    VALUES (bank_name, owner_uid)
    ON CONFLICT (user_id, lower(name)) DO NOTHING;
  END LOOP;
END $$;
