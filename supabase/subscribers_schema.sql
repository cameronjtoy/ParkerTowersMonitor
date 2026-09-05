-- Run this in the Supabase SQL editor, or via `supabase db query --linked --file supabase/subscribers_schema.sql`

create table if not exists subscribers (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null,     -- digits only, e.g. '5164279413'
  carrier text not null,          -- display name, e.g. 'T-Mobile'
  gateway_email text not null,    -- e.g. '5164279413@tmomail.net'
  created_at timestamptz not null default now(),
  active boolean not null default true
);

create unique index if not exists subscribers_gateway_email_key on subscribers (gateway_email);

alter table subscribers enable row level security;

-- No select policy is created, so phone numbers aren't publicly readable --
-- only monitor.py (service_role key, bypasses RLS) can list them.
--
-- Insert/update/delete are open (no confirmation step -- acceptable for a
-- small personal-use tool): anyone can add themselves, update their own row
-- on re-subscribe (upsert by gateway_email), or remove a number they know.
--
-- NOTE: the `to anon, authenticated` clause is required here -- a policy
-- relying on the implicit PUBLIC role scope (no `to` clause) was observed to
-- NOT apply correctly via PostgREST on this project, even though the same
-- policy worked fine when tested with a direct `SET ROLE anon` SQL session.
-- Root cause not fully identified; explicit role targeting is the verified
-- working pattern -- keep it explicit for any future policy on this project.
create policy "subscribers_all_access"
  on subscribers for all
  to anon, authenticated
  using (true)
  with check (true);
