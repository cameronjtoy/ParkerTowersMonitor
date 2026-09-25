# Parker Towers Apartment Monitor

Checks the shared availability feed for Stuyvesant Town / Parker Towers /
Kips Bay Court / Peter Cooper Village every 15 minutes (6–10am ET daily),
texts + emails on any unit under a price threshold, and publishes live
availability to a GitHub Pages site backed by Supabase.

## Architecture

```
cron-job.org (real clock, DST-aware)
  -> GitHub API workflow_dispatch
  -> monitor.py
       -> fetches https://units.stuytown.com/api/units
       -> emails + texts on newly-qualifying units (Gmail SMTP + SMS gateways)
       -> upserts every unit into Supabase "listings"   [service_role key]

GitHub Pages (docs/index.html)
  -> reads "listings" via Supabase anon key (read-only, enforced by RLS)
```

GitHub's own `schedule:` trigger is also left in the workflow as a free
backup, but it's unreliable at 15-minute frequency — cron-job.org is what
actually keeps this on schedule.

## Setup

### 1. Supabase project
1. Create a free project (or use an existing one).
2. Open **SQL Editor** and run `supabase/schema.sql`.
3. From **Settings > API**, copy the Project URL, the `anon` `public` key,
   and the `service_role` key (**secret**).

### 2. GitHub Actions secrets
**Settings > Secrets and variables > Actions**, add: `GMAIL_ADDRESS`,
`GMAIL_APP_PASSWORD`, `NOTIFY_EMAIL`, `SMS_GATEWAY_ADDRESS`,
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.

### 3. Frontend config
Copy `docs/config.example.js` to `docs/config.js` and fill in the Supabase
URL and **anon** key (never service_role). `docs/config.js` is gitignored.

### 4. GitHub Pages
**Settings > Pages** → deploy from branch → `main` / `/docs`. Requires the
repo to be public on the free plan.

### 5. cron-job.org
Create a job that POSTs to
`https://api.github.com/repos/<owner>/<repo>/actions/workflows/monitor.yml/dispatches`
with `Authorization: Bearer <fine-grained PAT scoped to Actions:write on this repo>`,
body `{"ref":"main"}`, every 15 minutes, 6am–10am, timezone America/New_York.

## Local testing

```
python3 monitor.py
```

Reads `config.json` (copy from `config.example.json`) instead of env vars
when `GMAIL_ADDRESS` isn't set in the environment. Set `FORCE_RUN=true` to
bypass the 6–10am gate.

## Run guide: `fetch_price_history.py` (house/co-op/condo sale history)

Populates two things on the For Sale tab's data, sourced from NYC's public
**ACRIS** deed records (`data.cityofnewyork.us`) — not a scraper, and not
against anyone's Terms of Service:

- `housing_price_history` — prior sale date + price per listing (used for
  the appreciation-rate line on each card).
- `housing_listings.property_type` — House / Condo / Co-op, for any listing
  that doesn't already have one set.

**Caveats, read before running:**
- Co-op sales are a stock/share transfer, not a recorded real-property deed
  — expect "NO MATCH" for most Co-op rows, that's expected, not a bug.
- Matching a Redfin-style address string to ACRIS's own street naming is
  inherently fuzzy (e.g. "215 STREET" vs "215TH STREET"). Treat results as
  best-effort, not exhaustive — some real addresses will still miss.
- It rate-limits itself (0.5s between listings) and can take a while on a
  full run. Get a free Socrata app token first if running against more than
  a handful of listings (see below) — without one you'll hit ACRIS's
  unauthenticated rate limit and every query gets noticeably slower.

### 1. Get a Socrata app token (optional but recommended)
Free, no approval wait: register at
https://data.cityofnewyork.us/profile/app_tokens, then:
```
export SOCRATA_APP_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 2. Pick a run mode

**Dry run** — test address matching against a local JSON file, no Supabase
credentials needed, nothing written anywhere:
```
python3 fetch_price_history.py --dry-run < some_listings.json
```
`some_listings.json` should be a JSON array of objects shaped like
`{"id": "...", "address": "...", "price": 123, "property_type": null}`.

**SQL output** — the safest way to run for real without ever putting a
`service_role` key in your shell environment. Needs `SUPABASE_URL` set (any
working key works for the read, since `housing_listings` is publicly
readable) plus the Supabase CLI:
```
export SUPABASE_URL=https://xxxx.supabase.co
export SUPABASE_ANON_KEY=eyJ...        # anon key is enough just to read listings
python3 fetch_price_history.py --sql-out /tmp/price_history.sql
supabase db query --linked --file /tmp/price_history.sql
rm /tmp/price_history.sql               # don't leave it lying around
```

**Direct write** — writes straight to Supabase via the REST API as it runs.
Needs the real `service_role` key (never commit it):
```
export SUPABASE_URL=https://xxxx.supabase.co
export SUPABASE_SERVICE_KEY=eyJ...      # service_role key -- bypasses RLS
python3 fetch_price_history.py
```

### 3. Re-running later
Safe to re-run anytime new listings get added — both writes are
upsert/on-conflict, so re-running never duplicates rows. It only fills in
`property_type` for listings that don't already have one, but always
re-checks sale history for every active listing.
