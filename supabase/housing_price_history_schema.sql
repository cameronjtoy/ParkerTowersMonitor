-- Run this in the Supabase SQL editor, or via
-- `supabase db query --linked --file supabase/housing_price_history_schema.sql`

-- Prior sale price + date per housing_listings row, sourced from NYC's
-- public ACRIS deed records (see fetch_price_history.py). Co-op listings
-- will typically have no rows here -- a co-op sale is a stock/share
-- transfer, not a real-property deed, so it's usually not in ACRIS at all.
create table if not exists housing_price_history (
  listing_id text not null references housing_listings(id) on delete cascade,
  sale_date date not null,
  sale_price numeric not null,
  primary key (listing_id, sale_date)
);

alter table housing_price_history enable row level security;

-- Same pattern as housing_listings: publicly readable, writes restricted
-- to the service_role key used by fetch_price_history.py.
create policy "housing_price_history is publicly readable"
  on housing_price_history for select
  using (true);
