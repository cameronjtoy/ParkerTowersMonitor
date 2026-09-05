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
