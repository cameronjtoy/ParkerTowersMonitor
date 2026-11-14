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

-- Deliberately NO policies for anon/authenticated: the table is not directly
-- readable or writable with the public anon key. The site reaches it only
-- through the password-checked functions in subscribers_lockdown.sql (run that
-- file after this one and app_settings_schema.sql). monitor.py uses the
-- service_role key, which bypasses RLS.
--
-- (An earlier version created a `for all ... using (true)` policy here. FOR ALL
-- includes SELECT, so it exposed every phone number; subscribers_lockdown.sql
-- drops it on existing projects.)

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
