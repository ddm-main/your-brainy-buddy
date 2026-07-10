
ALTER TABLE public.emails RENAME COLUMN from_address TO from_email;
ALTER TABLE public.projects ALTER COLUMN title DROP NOT NULL;
ALTER TABLE public.projects ALTER COLUMN slug DROP NOT NULL;
