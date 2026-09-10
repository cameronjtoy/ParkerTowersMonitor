-- Run this in the Supabase SQL editor (Project > SQL Editor > New query).

create table if not exists listings (
  id text primary key,               -- unitSpk from the units.stuytown.com feed
  property text not null,            -- 'Parker Towers' | 'Stuyvesant Town' | 'Kips Bay Court' | ...
  unit_number text,
  price numeric not null,
  beds numeric,
  baths numeric,
  sqft integer,
  address text,
  available_date text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  active boolean not null default true,   -- flipped false after MISS_THRESHOLD consecutive misses
  missed_count integer not null default 0 -- consecutive fetches this unit was absent from; grace period before delisting
);

alter table listings enable row level security;

-- Anyone with the public anon key (i.e. the deployed page) can read listings,
-- but only monitor.py (using the service_role key, kept in GitHub Actions secrets) can write.
create policy "listings are publicly readable"
  on listings for select
  using (true);

-- No insert/update/delete policy is created for the anon role, so writes stay
-- blocked for anyone but service_role.
