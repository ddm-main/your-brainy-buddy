
-- Enums
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('admin','user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.app_section AS ENUM ('hud','market','finance','tasks','projects','inbox','config');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- user_roles
CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- user_page_access
CREATE TABLE IF NOT EXISTS public.user_page_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  section public.app_section NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, section)
);
GRANT SELECT ON public.user_page_access TO authenticated;
GRANT ALL ON public.user_page_access TO service_role;
ALTER TABLE public.user_page_access ENABLE ROW LEVEL SECURITY;

-- has_role
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

-- has_section_access
CREATE OR REPLACE FUNCTION public.has_section_access(_user_id uuid, _section public.app_section)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_role(_user_id, 'admin')
      OR EXISTS (SELECT 1 FROM public.user_page_access WHERE user_id = _user_id AND section = _section)
$$;

-- Policies
DROP POLICY IF EXISTS "read own roles" ON public.user_roles;
CREATE POLICY "read own roles" ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(),'admin'));
DROP POLICY IF EXISTS "admins manage roles" ON public.user_roles;
CREATE POLICY "admins manage roles" ON public.user_roles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

DROP POLICY IF EXISTS "read own access" ON public.user_page_access;
CREATE POLICY "read own access" ON public.user_page_access FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(),'admin'));
DROP POLICY IF EXISTS "admins manage access" ON public.user_page_access;
CREATE POLICY "admins manage access" ON public.user_page_access FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- Replace old signup-block trigger
CREATE OR REPLACE FUNCTION public.block_new_signups()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.id = '2ff4497a-dedc-4885-98e5-435b26894275'::uuid THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.raw_user_meta_data->>'created_by_admin', '') = 'true' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'signups are disabled';
END;
$$;

-- Auto-assign role & default sections on new user
CREATE OR REPLACE FUNCTION public.assign_default_role_and_access()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  is_owner boolean := (lower(COALESCE(NEW.email,'')) = 'msdeepakdon@gmail.com');
  requested_role text := COALESCE(NEW.raw_user_meta_data->>'requested_role', 'user');
  requested_sections text[] := ARRAY(
    SELECT jsonb_array_elements_text(COALESCE(NEW.raw_user_meta_data->'requested_sections', '["market"]'::jsonb))
  );
  s text;
BEGIN
  IF is_owner THEN
    INSERT INTO public.user_roles(user_id, role) VALUES (NEW.id, 'admin')
      ON CONFLICT DO NOTHING;
    FOR s IN SELECT unnest(ARRAY['hud','market','finance','tasks','projects','inbox','config']) LOOP
      INSERT INTO public.user_page_access(user_id, section) VALUES (NEW.id, s::public.app_section)
        ON CONFLICT DO NOTHING;
    END LOOP;
  ELSE
    INSERT INTO public.user_roles(user_id, role)
      VALUES (NEW.id, CASE WHEN requested_role = 'admin' THEN 'admin'::public.app_role ELSE 'user'::public.app_role END)
      ON CONFLICT DO NOTHING;
    IF requested_role = 'admin' THEN
      FOR s IN SELECT unnest(ARRAY['hud','market','finance','tasks','projects','inbox','config']) LOOP
        INSERT INTO public.user_page_access(user_id, section) VALUES (NEW.id, s::public.app_section)
          ON CONFLICT DO NOTHING;
      END LOOP;
    ELSE
      IF array_length(requested_sections,1) IS NULL THEN
        requested_sections := ARRAY['market'];
      END IF;
      FOREACH s IN ARRAY requested_sections LOOP
        BEGIN
          INSERT INTO public.user_page_access(user_id, section) VALUES (NEW.id, s::public.app_section)
            ON CONFLICT DO NOTHING;
        EXCEPTION WHEN invalid_text_representation THEN NULL; END;
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_assign_access ON auth.users;
CREATE TRIGGER on_auth_user_created_assign_access
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.assign_default_role_and_access();

-- Seed owner as admin with all sections
INSERT INTO public.user_roles(user_id, role)
VALUES ('2ff4497a-dedc-4885-98e5-435b26894275','admin')
ON CONFLICT DO NOTHING;

INSERT INTO public.user_page_access(user_id, section)
SELECT '2ff4497a-dedc-4885-98e5-435b26894275'::uuid, s::public.app_section
FROM unnest(ARRAY['hud','market','finance','tasks','projects','inbox','config']) AS s
ON CONFLICT DO NOTHING;
