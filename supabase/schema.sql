-- ---------------------------------------------------------------------------
-- CodeFort — Supabase schema
--
-- Run this once in the Supabase SQL editor for the project whose URL and
-- publishable key you stored as the SUP_URL and SUP_PB repository secrets.
--
-- A publication is one workspace snapshot addressed by a random slug and
-- served back at  https://<host>/CodeFort/?=<slug>
--
-- Accounts come from Supabase Auth. Nothing extra is needed for sign-up beyond
-- enabling the Email provider under Authentication → Providers; CodeFort talks
-- to /auth/v1 directly. Turning "Confirm email" on is recommended — the app
-- handles the confirm-then-sign-in flow.
--
-- Upgrading a project created before accounts existed? Publications have no
-- owner, so back-fill or clear them before the not-null column lands:
--
--   alter table public.publications
--     add column if not exists user_id uuid references auth.users (id)
--       on delete cascade default auth.uid();
--   delete from public.publications where user_id is null;  -- or set an owner
--   alter table public.publications alter column user_id set not null;
--
-- then run this file to replace the policies.
-- ---------------------------------------------------------------------------

create table if not exists public.publications (
  slug        text primary key
              check (slug ~ '^[a-z0-9]{6,64}$'),
  user_id     uuid not null
              references auth.users (id) on delete cascade
              default auth.uid(),
  name        text not null
              check (char_length(name) between 1 and 120),
  title       text check (char_length(title) <= 200),
  description text check (char_length(description) <= 500),
  entry       text not null default '/index.html',
  files       jsonb not null
              check (jsonb_typeof(files) = 'object'),
  created_at  timestamptz not null default now(),

  -- Cap a single publication at ~2 MB of source so one caller cannot fill
  -- the table with a giant blob.
  constraint publications_size check (pg_column_size(files) < 2 * 1024 * 1024)
);

create index if not exists publications_created_at_idx
  on public.publications (created_at desc);

create index if not exists publications_user_id_idx
  on public.publications (user_id);

-- ---------------------------------------------------------------------------
-- Row level security
--
-- The publishable/anon key ships to the browser by design, so the policies
-- below are the only thing standing between the internet and this table:
--   • anyone may read a publication, signed in or not — that is what
--     publishing means, and it is why a ?=<slug> link needs no account
--   • only a signed-in account may insert, and only as itself
--   • nobody may update — publications are immutable once written, so a
--     stranger cannot rewrite someone else's published site
--   • an account may delete its own publications, and only its own
-- ---------------------------------------------------------------------------

alter table public.publications enable row level security;

drop policy if exists "publications are world readable" on public.publications;
create policy "publications are world readable"
  on public.publications
  for select
  to anon, authenticated
  using (true);

-- Older deployments had an open insert policy. Drop it explicitly so running
-- this file again on an existing project actually closes the hole.
drop policy if exists "anyone may publish" on public.publications;

drop policy if exists "accounts publish as themselves" on public.publications;
create policy "accounts publish as themselves"
  on public.publications
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "accounts delete their own publications" on public.publications;
create policy "accounts delete their own publications"
  on public.publications
  for delete
  to authenticated
  using (user_id = auth.uid());

-- No update policy is defined, so updates are denied for everyone through the
-- API. Housekeeping runs as the service role, from the SQL editor.

-- ---------------------------------------------------------------------------
-- Optional: keep the table from growing without bound.
-- Uncomment and schedule with pg_cron if you want publications to expire.
-- ---------------------------------------------------------------------------

-- select cron.schedule(
--   'codefort-prune',
--   '0 4 * * *',
--   $$ delete from public.publications where created_at < now() - interval '90 days' $$
-- );
