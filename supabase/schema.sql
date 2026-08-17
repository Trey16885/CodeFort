-- ---------------------------------------------------------------------------
-- CodeFort — Supabase schema
--
-- Run this once in the Supabase SQL editor for the project whose URL and
-- publishable key you stored as the SUP_URL and SUP_PB repository secrets.
--
-- A publication is one workspace snapshot addressed by a random slug and
-- served back at  https://<host>/CodeFort/?=<slug>
-- ---------------------------------------------------------------------------

create table if not exists public.publications (
  slug        text primary key
              check (slug ~ '^[a-z0-9]{6,64}$'),
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

-- ---------------------------------------------------------------------------
-- Row level security
--
-- The publishable/anon key ships to the browser by design, so the policies
-- below are the only thing standing between the internet and this table:
--   • anyone may read a publication (that is the point of publishing)
--   • anyone may insert a new one
--   • nobody may update or delete through the API — publications are
--     immutable once written, so a stranger cannot rewrite someone's site
-- ---------------------------------------------------------------------------

alter table public.publications enable row level security;

drop policy if exists "publications are world readable" on public.publications;
create policy "publications are world readable"
  on public.publications
  for select
  to anon, authenticated
  using (true);

drop policy if exists "anyone may publish" on public.publications;
create policy "anyone may publish"
  on public.publications
  for insert
  to anon, authenticated
  with check (true);

-- No update or delete policy is defined, so both are denied for anon and
-- authenticated. Housekeeping runs as the service role, from the SQL editor.

-- ---------------------------------------------------------------------------
-- Optional: keep the table from growing without bound.
-- Uncomment and schedule with pg_cron if you want publications to expire.
-- ---------------------------------------------------------------------------

-- select cron.schedule(
--   'codefort-prune',
--   '0 4 * * *',
--   $$ delete from public.publications where created_at < now() - interval '90 days' $$
-- );
