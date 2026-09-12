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

-- Per-bedroom-count price ceilings, e.g. {"0": 1700, "1": 2000, "2": 2400}.
-- Key is bedroom count as text ("0" = studio); "3" is used for 3+ bedrooms.
-- A bedroom count with no key is not something this subscriber wants texts
-- about. Empty object (the default) means "not yet configured" -- monitor.py
-- treats that as no alerts until the subscriber sets at least one threshold.
alter table subscribers add column if not exists thresholds jsonb not null default '{}'::jsonb;

-- Tracks which (subscriber, unit) pairs have already been texted, since
-- qualification is now per-subscriber (different thresholds) rather than one
-- global list -- the old seen_units.json can't dedupe this on its own.
create table if not exists subscriber_notifications (
  subscriber_id uuid not null references subscribers(id) on delete cascade,
  unit_id text not null,
  notified_at timestamptz not null default now(),
  primary key (subscriber_id, unit_id)
);

alter table subscriber_notifications enable row level security;
-- No policies: only monitor.py (service_role key, bypasses RLS) touches this table.
