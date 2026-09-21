-- Run via `supabase db query --linked --file supabase/building_suggestions_schema.sql`

-- Free-text suggestions from site visitors for buildings/addresses they'd
-- like added to the monitor. Write-only from the public's perspective --
-- no select policy, so the anon key can insert a suggestion but can't read
-- anyone else's (avoids exposing the list to scraping/spam). The owner
-- reads these via the Supabase dashboard (service_role bypasses RLS).
create table if not exists building_suggestions (
  id uuid primary key default gen_random_uuid(),
  suggestion text not null,
  contact text,
  submitted_at timestamptz not null default now()
);

alter table building_suggestions enable row level security;

create policy "anyone can submit a suggestion"
  on building_suggestions for insert
  with check (true);
