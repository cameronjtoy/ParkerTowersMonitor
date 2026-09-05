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

-- Anyone can add themselves (the public signup form uses the anon key).
-- No select policy is created for anon, so phone numbers aren't publicly
-- readable -- only monitor.py (service_role key, bypasses RLS) can list them.
create policy "anyone can subscribe"
  on subscribers for insert
  with check (true);

-- Lets the frontend's upsert-by-gateway_email re-activate/update an existing
-- row (e.g. re-subscribing) instead of failing on conflict.
create policy "anyone can update a subscription"
  on subscribers for update
  using (true)
  with check (true);

-- Anyone who knows a phone number can remove it (self-serve unsubscribe,
-- no confirmation step -- acceptable for a small personal-use tool).
create policy "anyone can unsubscribe by phone number"
  on subscribers for delete
  using (true);
