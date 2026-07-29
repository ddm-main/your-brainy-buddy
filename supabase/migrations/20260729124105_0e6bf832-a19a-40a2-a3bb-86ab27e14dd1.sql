CREATE TABLE IF NOT EXISTS public.market_holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange text NOT NULL DEFAULT 'NSE',
  holiday_date date NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exchange, holiday_date)
);

GRANT SELECT ON public.market_holidays TO authenticated;
GRANT ALL ON public.market_holidays TO service_role;

ALTER TABLE public.market_holidays ENABLE ROW LEVEL SECURITY;

CREATE POLICY "market_holidays_read" ON public.market_holidays
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "market_holidays_admin_write" ON public.market_holidays
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_market_holidays_updated_at
  BEFORE UPDATE ON public.market_holidays
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.market_holidays (exchange, holiday_date, description) VALUES
  ('NSE','2026-01-26','Republic Day'),
  ('NSE','2026-03-04','Holi'),
  ('NSE','2026-03-21','Id-Ul-Fitr'),
  ('NSE','2026-03-26','Ram Navami'),
  ('NSE','2026-03-31','Mahavir Jayanti'),
  ('NSE','2026-04-03','Good Friday'),
  ('NSE','2026-04-14','Dr. Ambedkar Jayanti'),
  ('NSE','2026-05-01','Maharashtra Day'),
  ('NSE','2026-05-28','Bakri Id'),
  ('NSE','2026-06-26','Muharram'),
  ('NSE','2026-08-15','Independence Day'),
  ('NSE','2026-08-26','Ganesh Chaturthi'),
  ('NSE','2026-10-02','Mahatma Gandhi Jayanti'),
  ('NSE','2026-10-20','Dussehra'),
  ('NSE','2026-11-09','Diwali Balipratipada'),
  ('NSE','2026-11-24','Guru Nanak Jayanti'),
  ('NSE','2026-12-25','Christmas')
ON CONFLICT (exchange, holiday_date) DO NOTHING;