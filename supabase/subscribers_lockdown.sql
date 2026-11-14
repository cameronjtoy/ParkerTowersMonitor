-- Run via `supabase db query --linked --file supabase/subscribers_lockdown.sql`
-- (or paste into the Supabase SQL editor). Safe to re-run.
--
-- Requires subscribers_schema.sql and app_settings_schema.sql to have run first.
--
-- WHY: the original "subscribers_all_access" policy was `for all ... using
-- (true)` to anon. FOR ALL includes SELECT, so anyone holding the public anon
-- key (it ships in docs/config.js) could read every subscriber's phone number
-- and carrier, rewrite anyone's thresholds or gateway address, delete rows, and
-- add numbers without the signup password (that gate was only checked in the
-- browser). This file removes all direct table access for anon and exposes
-- three narrow security-definer functions that check the password server-side
-- and validate every field.
--
-- ORDER: run this BEFORE deploying the matching docs/rentals.js -- the site
-- calls these functions instead of the table.

-- 1. No direct access to the table for the public roles.
drop policy if exists "subscribers_all_access" on subscribers;
revoke all on subscribers from anon, authenticated;

-- 2. Throttle wrong-password attempts (the password is shared and short, and
--    check_signup_password was an unlimited guessing oracle). Global, not
--    per-IP: Postgres doesn't see client IPs through PostgREST. At most 20
--    wrong guesses per 10 minutes across everyone.
create table if not exists signup_password_failures (
  at timestamptz not null default now()
);
alter table signup_password_failures enable row level security;
-- No policies: only the security-definer functions below touch it.
revoke all on signup_password_failures from anon, authenticated;

create or replace function _signup_password_ok(p_password text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  delete from signup_password_failures where at < now() - interval '1 day';
  if (select count(*) from signup_password_failures where at > now() - interval '10 minutes') >= 20 then
    raise exception 'too many attempts, try again later' using errcode = '54000';
  end if;
  v_ok := exists (select 1 from app_settings where key = 'signup_password' and value = p_password);
  if not v_ok then
    insert into signup_password_failures default values;
  end if;
  return v_ok;
end;
$$;
revoke execute on function _signup_password_ok(text) from public, anon, authenticated;

-- A wrong password must NOT raise: an exception rolls back the transaction,
-- which would also roll back the failure row recorded above and defeat the
-- throttle. So the public functions below return {"status": "invalid_password"}
-- instead, and only raise for bad input after the password has checked out.
-- Each returns jsonb: {"status": "ok", ...} or {"status": "invalid_password"}.
-- Clean up the earlier draft helper if it was ever created.
drop function if exists _require_signup_password(text);

-- Same boolean contract the site already uses to unlock the form, now throttled.
create or replace function check_signup_password(input text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  return _signup_password_ok(input);
end;
$$;
revoke execute on function check_signup_password(text) from public;
grant execute on function check_signup_password(text) to anon, authenticated;

-- 3. Carrier -> SMS gateway domain. Server-side so a caller can't point a
--    "subscription" at an arbitrary email address and have the monitor mail it.
--    Keep in sync with CARRIER_GATEWAYS in docs/rentals.js.
create or replace function carrier_gateway_domain(p_carrier text)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_carrier
    when 'AT&T' then 'txt.att.net'
    when 'Verizon' then 'vtext.com'
    when 'T-Mobile' then 'tmomail.net'
    when 'Mint Mobile' then 'tmomail.net'
    when 'Metro by T-Mobile' then 'mymetropcs.com'
    when 'Boost Mobile' then 'sms.myboostmobile.com'
    when 'Cricket Wireless' then 'sms.cricketwireless.net'
    when 'US Cellular' then 'email.uscc.net'
    when 'Google Fi' then 'msg.fi.google.com'
    when 'Visible' then 'vtext.com'
    when 'Xfinity Mobile' then 'vtext.com'
    else null
  end;
$$;

-- 4. Add or update a number (upsert on gateway_email, as before).
drop function if exists subscribe_number(text, text, text, jsonb);
create or replace function subscribe_number(p_password text, p_phone text, p_carrier text, p_thresholds jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_domain text;
  v_clean jsonb := '{}'::jsonb;
  v_key text;
  v_val jsonb;
begin
  if not _signup_password_ok(p_password) then
    return jsonb_build_object('status', 'invalid_password');
  end if;
  if p_phone is null or p_phone !~ '^[0-9]{10}$' then
    raise exception 'invalid phone number' using errcode = '22023';
  end if;
  v_domain := carrier_gateway_domain(p_carrier);
  if v_domain is null then
    raise exception 'unknown carrier' using errcode = '22023';
  end if;
  if p_thresholds is null or jsonb_typeof(p_thresholds) <> 'object' then
    raise exception 'invalid thresholds' using errcode = '22023';
  end if;
  for v_key, v_val in select key, value from jsonb_each(p_thresholds) loop
    if v_key not in ('0', '1', '2', '3')
       or jsonb_typeof(v_val) <> 'number'
       or (v_val #>> '{}')::numeric <= 0
       or (v_val #>> '{}')::numeric > 100000 then
      raise exception 'invalid thresholds' using errcode = '22023';
    end if;
    v_clean := v_clean || jsonb_build_object(v_key, v_val);
  end loop;
  if v_clean = '{}'::jsonb then
    raise exception 'set a max price for at least one bedroom count' using errcode = '22023';
  end if;

  insert into subscribers (phone_number, carrier, gateway_email, active, thresholds)
  values (p_phone, p_carrier, p_phone || '@' || v_domain, true, v_clean)
  on conflict (gateway_email) do update
    set carrier = excluded.carrier, active = true, thresholds = excluded.thresholds;
  return jsonb_build_object('status', 'ok');
end;
$$;
revoke execute on function subscribe_number(text, text, text, jsonb) from public;
grant execute on function subscribe_number(text, text, text, jsonb) to anon, authenticated;

-- 5. Pre-fill the form for a returning number. Only carrier + thresholds,
--    and only with the password, so it can't be used to look numbers up.
-- (Return type changed from any earlier draft, so drop first.)
drop function if exists get_subscriber_settings(text, text);
create or replace function get_subscriber_settings(p_password text, p_phone text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  if not _signup_password_ok(p_password) then
    return jsonb_build_object('status', 'invalid_password');
  end if;
  select s.carrier, s.thresholds into v_row
    from subscribers s
    where s.phone_number = p_phone
    order by s.created_at desc
    limit 1;
  if not found then
    return jsonb_build_object('status', 'ok', 'found', false);
  end if;
  return jsonb_build_object('status', 'ok', 'found', true, 'carrier', v_row.carrier, 'thresholds', v_row.thresholds);
end;
$$;
revoke execute on function get_subscriber_settings(text, text) from public;
grant execute on function get_subscriber_settings(text, text) to anon, authenticated;

-- 6. Remove a number. Password required, so a stranger who knows a number
--    can't unsubscribe it. Returns "ok" whether or not the number existed, so
--    it can't be used to test whether a number is subscribed.
drop function if exists unsubscribe_number(text, text);
create or replace function unsubscribe_number(p_password text, p_phone text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not _signup_password_ok(p_password) then
    return jsonb_build_object('status', 'invalid_password');
  end if;
  if p_phone is null or p_phone !~ '^[0-9]{10}$' then
    raise exception 'invalid phone number' using errcode = '22023';
  end if;
  delete from subscribers where phone_number = p_phone;
  return jsonb_build_object('status', 'ok');
end;
$$;
revoke execute on function unsubscribe_number(text, text) from public;
grant execute on function unsubscribe_number(text, text) to anon, authenticated;
