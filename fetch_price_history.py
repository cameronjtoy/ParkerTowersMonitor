#!/usr/bin/env python3
"""
Backfills real prior-sale price history for docs/housing.html's listings,
sourced from NYC's public ACRIS deed records (data.cityofnewyork.us) --
not a scraper, and not against anyone's Terms of Service.

CAVEAT: this only finds anything for condos and houses. Co-op sales are a
stock/share transfer, not a real-property deed, so they generally aren't in
ACRIS at all -- expect "no ACRIS match" for most Co-op rows, that's normal.

CAVEAT 2: matching a Redfin address string to an ACRIS street_name is
inherently fuzzy -- ACRIS itself isn't consistently formatted (e.g. some
numbered streets are recorded as "215 STREET", others as "195TH STREET").
This tries a handful of normalizations per address and takes the first
match; it will still miss some real addresses and should be treated as
best-effort, not exhaustive.

Run with SOCRATA_APP_TOKEN set (free, register at https://data.cityofnewyork.us/profile/app_tokens)
to avoid the unauthenticated rate limit -- without one this is slow
(each ACRIS query can take 5-15s) and may get throttled on a big run.

Environment variables:
  SUPABASE_URL          - e.g. https://xxxx.supabase.co
  SUPABASE_SERVICE_KEY  - service_role key (bypasses RLS) -- never commit this
  SOCRATA_APP_TOKEN      - optional, speeds up / raises rate limits on ACRIS calls
"""

import os
import re
import sys
import time
import urllib.parse
import urllib.request
import json
from datetime import date

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
SOCRATA_APP_TOKEN = os.environ.get("SOCRATA_APP_TOKEN")

ACRIS_LEGALS = "https://data.cityofnewyork.us/resource/8h5j-fqxa.json"
ACRIS_MASTER = "https://data.cityofnewyork.us/resource/bnx9-e6tj.json"

# Real-property transfer document types. The DEED itself frequently carries
# document_amt=0 -- the actual sale price is usually on the companion
# "RPTT&RET" (Real Property Transfer Tax return) document instead.
DEED_DOC_TYPES = {"DEED", "DEEDO", "CORRD", "CONDOP", "RPTT&RET", "RPTT", "RPTTR", "RPTT-B"}

ZIP_PREFIX_TO_BOROUGH = {
    "100": "1", "101": "1", "102": "1",   # Manhattan
    "104": "2",                            # Bronx
    "112": "3",                            # Brooklyn
    "103": "5",                            # Staten Island
    "110": "4", "111": "4", "113": "4", "114": "4", "116": "4",  # Queens
}

STREET_SUFFIX_EXPANSIONS = {
    "AVE": "AVENUE", "AV": "AVENUE",
    "BLVD": "BOULEVARD",
    "ST": "STREET",
    "RD": "ROAD",
    "DR": "DRIVE",
    "PL": "PLACE",
    "PKWY": "PARKWAY",
    "CT": "COURT",
    "LN": "LANE",
    "TER": "TERRACE",
    "SQ": "SQUARE",
    "EXPY": "EXPRESSWAY",
    "HWY": "HIGHWAY",
    "PLZ": "PLAZA",
}

UNIT_PATTERN = re.compile(r"\b(?:Unit|Apt|Ph)\s*[-#]?\s*(\S+)\s*,", re.I)
ZIP_PATTERN = re.compile(r"(\d{5})\s*$")
STREET_NUMBER_PATTERN = re.compile(r"^(\d+-?\d*)\s+(.*)$")
ORDINAL_SUFFIX_PATTERN = re.compile(r"^(\d+)(ST|ND|RD|TH)$", re.I)


def zip_to_borough(zip5):
    return ZIP_PREFIX_TO_BOROUGH.get(zip5[:3]) if zip5 else None


def parse_address(address):
    """Best-effort split of a Redfin-style address into ACRIS-queryable parts."""
    zip_match = ZIP_PATTERN.search(address)
    zip5 = zip_match.group(1) if zip_match else None
    borough = zip_to_borough(zip5)

    unit_match = UNIT_PATTERN.search(address)
    unit = unit_match.group(1).upper() if unit_match else None

    street_part = address.split(",")[0].strip()
    # Drop a trailing "Unit X" / "Apt X" / "Ph X" from the street portion.
    street_part = re.split(r"\b(?:Unit|Apt|Ph)\b", street_part, flags=re.I)[0].strip()

    m = STREET_NUMBER_PATTERN.match(street_part)
    if not m or not borough:
        return None
    street_number, street_name_raw = m.group(1), m.group(2).strip().upper()

    # Expand a trailing abbreviation (e.g. "SPRINGFIELD BLVD" -> "SPRINGFIELD BOULEVARD").
    words = street_name_raw.split()
    if words and words[-1] in STREET_SUFFIX_EXPANSIONS:
        words[-1] = STREET_SUFFIX_EXPANSIONS[words[-1]]
    expanded = " ".join(words)

    # Build a few plausible street_name variants -- ACRIS isn't consistent
    # about ordinal suffixes on numbered streets/avenues. Order doesn't
    # matter for correctness (all variants get queried and merged -- see
    # find_sale_history), but dict.fromkeys keeps it deterministic for
    # logging/debugging instead of relying on set iteration order.
    variants = dict.fromkeys([street_name_raw, expanded])
    for variant in list(variants):
        ord_match = ORDINAL_SUFFIX_PATTERN.match(variant.split()[0]) if variant.split() else None
        if ord_match:
            num = ord_match.group(1)
            rest = " ".join(variant.split()[1:])
            variants[f"{num} {rest}".strip()] = None
        elif variant.split() and variant.split()[0].isdigit():
            num = variant.split()[0]
            rest = " ".join(variant.split()[1:])
            for suf in ("TH", "ST", "ND", "RD"):
                variants[f"{num}{suf} {rest}".strip()] = None

    return {
        "borough": borough,
        "street_number": street_number,
        "street_name_variants": [v for v in variants if v],
        "unit": unit,
    }


def socrata_get(url, params, max_time=60):
    if SOCRATA_APP_TOKEN:
        params = dict(params, **{"$$app_token": SOCRATA_APP_TOKEN})
    full_url = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(full_url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=max_time) as resp:
        return json.loads(resp.read())


def find_sale_history(parsed):
    """Returns a list of {sale_date, sale_price} dicts, newest first.

    A single sale is recorded as at least two ACRIS documents -- the DEED
    (which frequently has document_amt=0) and a companion RPTT&RET filing
    that carries the actual price -- each with its OWN document_id. So we
    can't filter by unit at the legals step: the price-bearing document
    for our unit might not itself carry a matching (or any) unit value.
    Instead, pull every document_id for the whole building first, look up
    which of those have a real sale amount, and only THEN check which unit
    each of those specific documents belongs to.
    """
    # Query every spelling variant and merge -- a wrong-but-nonempty variant
    # (e.g. matching some unrelated address that happens to share a street
    # number) is harmless here since it just adds documents that won't carry
    # our target unit; stopping at the "first" variant instead risked landing
    # on the wrong one, since street_name_variants' order isn't meaningful.
    doc_info = {}  # document_id -> {"unit": ..., "block_lot": (block, lot)}
    for street_name in parsed["street_name_variants"]:
        try:
            rows = socrata_get(
                ACRIS_LEGALS,
                {
                    "borough": parsed["borough"],
                    "street_number": parsed["street_number"],
                    "street_name": street_name,
                    "$limit": 1000,
                },
            )
        except Exception as e:
            print(f"    legals query failed for {street_name!r}: {e}", file=sys.stderr)
            continue
        for r in rows:
            doc_info[r["document_id"]] = {
                "unit": r.get("unit"),
                "block_lot": (r.get("block"), r.get("lot")),
            }

    if not doc_info:
        return []

    # A house has no unit to disambiguate with, so if the merged variants
    # accidentally pulled in an unrelated address sharing the same street
    # number, restrict to whichever (block, lot) shows up most -- the real
    # building normally has far more filings over the years than a one-off
    # spelling collision would.
    if not parsed["unit"]:
        block_lot_counts = {}
        for info in doc_info.values():
            block_lot_counts[info["block_lot"]] = block_lot_counts.get(info["block_lot"], 0) + 1
        target_block_lot = max(block_lot_counts, key=block_lot_counts.get)
        doc_info = {k: v for k, v in doc_info.items() if v["block_lot"] == target_block_lot}

    unit_by_doc_id = {k: v["unit"] for k, v in doc_info.items()}

    sales = []
    # ACRIS document_id values are opaque strings; batch the $in filter.
    # Chunk to stay well under Socrata's URL/query-length limits on big buildings.
    doc_ids = list(unit_by_doc_id.keys())
    target_unit = re.sub(r"[-\s]", "", parsed["unit"]).upper() if parsed["unit"] else None
    for i in range(0, len(doc_ids), 200):
        chunk = doc_ids[i:i + 200]
        id_list = ",".join(f"'{d}'" for d in chunk)
        try:
            docs = socrata_get(
                ACRIS_MASTER,
                {"$where": f"document_id in ({id_list}) AND document_amt > '0'", "$limit": 200},
            )
        except Exception as e:
            print(f"    master query failed: {e}", file=sys.stderr)
            continue

        for d in docs:
            if d.get("doc_type") not in DEED_DOC_TYPES:
                continue
            if target_unit is not None:
                doc_unit = unit_by_doc_id.get(d["document_id"])
                if re.sub(r"[-\s]", "", (doc_unit or "").upper()) != target_unit:
                    continue
            try:
                amt = float(d["document_amt"])
            except (KeyError, ValueError):
                continue
            if amt <= 0:
                continue
            sales.append({"sale_date": d["document_date"][:10], "sale_price": amt})

    # Multiple documents (DEED + RPTT&RET) can record the same sale event;
    # keep one amount per date.
    by_date = {}
    for s in sales:
        by_date[s["sale_date"]] = s["sale_price"]
    sales = [{"sale_date": d, "sale_price": p} for d, p in by_date.items()]
    sales.sort(key=lambda s: s["sale_date"], reverse=True)
    return sales


def sql_literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def upsert_sql(listing_id, sale_date, sale_price):
    return (
        "insert into housing_price_history (listing_id, sale_date, sale_price) values "
        f"({sql_literal(listing_id)}, {sql_literal(sale_date)}, {sale_price}) "
        "on conflict (listing_id, sale_date) do update set sale_price = excluded.sale_price;"
    )


def supabase_request(method, path, body=None):
    key = SUPABASE_SERVICE_KEY or os.environ.get("SUPABASE_ANON_KEY")
    url = SUPABASE_URL.rstrip("/") + path
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def main():
    dry_run = "--dry-run" in sys.argv
    sql_out_path = None
    if "--sql-out" in sys.argv:
        sql_out_path = sys.argv[sys.argv.index("--sql-out") + 1]

    if not dry_run and not sql_out_path and not (SUPABASE_URL and SUPABASE_SERVICE_KEY):
        print(
            "SUPABASE_URL / SUPABASE_SERVICE_KEY not set -- pass --dry-run to test matching "
            "only, or --sql-out <file> to emit SQL for `supabase db query` instead of using the "
            "REST API (reading listings still needs SUPABASE_URL, but any working key works since "
            "housing_listings is publicly readable).",
            file=sys.stderr,
        )
        sys.exit(1)

    if dry_run:
        listings = json.loads(sys.stdin.read())
    else:
        listings = supabase_request(
            "GET", "/rest/v1/housing_listings?select=id,address,price&active=eq.true"
        ) or []

    sql_statements = []
    matched, unmatched = 0, 0
    for listing in listings:
        parsed = parse_address(listing["address"])
        if not parsed:
            print(f"SKIP (unparseable address): {listing['address']}")
            unmatched += 1
            continue

        sales = find_sale_history(parsed)
        if not sales:
            print(f"NO MATCH: {listing['address']}")
            unmatched += 1
            time.sleep(0.5)
            continue

        matched += 1
        last = sales[0]
        print(f"MATCH: {listing['address']} -> last sold ${last['sale_price']:,.0f} on {last['sale_date']} ({len(sales)} sale(s) found)")

        if sql_out_path:
            for s in sales:
                sql_statements.append(upsert_sql(listing["id"], s["sale_date"], s["sale_price"]))
        elif not dry_run:
            for s in sales:
                supabase_request(
                    "POST", "/rest/v1/housing_price_history?on_conflict=listing_id,sale_date",
                    body={
                        "listing_id": listing["id"],
                        "sale_date": s["sale_date"],
                        "sale_price": s["sale_price"],
                    },
                )
        time.sleep(0.5)

    if sql_out_path:
        with open(sql_out_path, "w") as f:
            f.write("\n".join(sql_statements) + "\n" if sql_statements else "")
        print(f"\nWrote {len(sql_statements)} SQL statement(s) to {sql_out_path}")

    print(f"\nDone. {matched} matched, {unmatched} unmatched.")


if __name__ == "__main__":
    main()
