-- Run via `supabase db query --linked --file supabase/app_settings_schema.sql`

-- Holds app-level secrets (e.g. the signup form password) that the client
-- should never be able to read directly.
create table if not exists app_settings (
  key text primary key,
  value text not null
);

alter table app_settings enable row level security;
-- Deliberately no select/insert/update policies -- the anon key gets zero
-- direct access to this table. The only way in or out is the function below.

-- security definer lets this run as the table owner (bypassing RLS) even
-- though it's called with the anon key, but it only ever returns a boolean --
-- the stored password itself never reaches the client.
create or replace function check_signup_password(input text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from app_settings where key = 'signup_password' and value = input
  );
$$;

grant execute on function check_signup_password(text) to anon;
