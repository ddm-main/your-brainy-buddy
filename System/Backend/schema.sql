-- JARVIS OS — Supabase backend schema
-- Mirror of the file-based OS. Files are the working copy; these tables are the
-- queryable system of record. Run once in the Supabase SQL editor (or via /sync setup).

create extension if not exists pgcrypto;

-- What JARVIS knows about Deepak (System/Memory/*)
create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  category text not null,              -- profile | preferences | people | decisions | <topic>
  content text not null,               -- one fact/entry per row
  source_file text,                    -- e.g. System/Memory/profile.md
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Captured items (Inbox/inbox.md)
create table if not exists inbox_items (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  captured_on date not null default current_date,
  processed boolean not null default false,
  routed_to text,                      -- destination when processed
  created_at timestamptz not null default now()
);

-- Projects (Projects/*/_overview.md)
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,           -- kebab-case folder name
  title text not null,
  outcome text,
  deadline date,
  status text not null default 'active' check (status in ('active','done','archived')),
  started_on date not null default current_date,
  updated_at timestamptz not null default now()
);

create table if not exists next_actions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  description text not null,
  done boolean not null default false,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

-- Life areas (Areas/*/_overview.md)
create table if not exists areas (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,           -- Health, Finance, Career, Learning, Personal
  standard text,                       -- the bar to maintain
  health_check text,                   -- latest one-line pulse
  reviewed_at timestamptz
);

-- Daily logs & journal (System/Logs/YYYY-MM-DD.md)
create table if not exists daily_logs (
  id uuid primary key default gen_random_uuid(),
  log_date date unique not null,
  content text not null,               -- full markdown of the day's file
  updated_at timestamptz not null default now()
);

-- Lock the tables down; JARVIS connects with privileged access via MCP.
-- Add policies later if a web/mobile client needs direct anon access.
alter table memories enable row level security;
alter table inbox_items enable row level security;
alter table projects enable row level security;
alter table next_actions enable row level security;
alter table areas enable row level security;
alter table daily_logs enable row level security;

-- Seed the five standing areas
insert into areas (name) values ('Health'),('Finance'),('Career'),('Learning'),('Personal')
on conflict (name) do nothing;
