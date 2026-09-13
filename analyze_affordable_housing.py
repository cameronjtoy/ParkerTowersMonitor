"""Pull HPD's official "Affordable Housing Production by Building" dataset
(NYC Open Data id hg8x-zxpr) for the same Queens/Brooklyn zip codes used
elsewhere in this project, and reduce it to income-tier unit counts per
neighborhood and per building.

Unlike the HPD registration CSV, this dataset is small enough (a few
hundred rows for our zips) and CORS-enabled, so it's queried live via
Socrata's API rather than requiring a manual export -- but we still write
a static JSON snapshot (same pattern as hpd_complexes.json) so the page
doesn't depend on a third-party API at load time.

Usage: python3 analyze_affordable_housing.py
"""
import json
import urllib.request
import urllib.parse
from collections import defaultdict

OUT_PATH = "docs/affordable_housing.json"
SOCRATA_URL = "https://data.cityofnewyork.us/resource/hg8x-zxpr.json"

# Same zip -> neighborhood map used in analyze_hpd_buildings.py, so both
# datasets line up on the same neighborhood labels.
ZIP_TO_NEIGHBORHOODS = {
    "11360": ["Bayside"],
    "11361": ["Bayside"],
    "11364": ["Bayside", "Oakland Gardens"],
    "11375": ["Forest Hills", "Queens"],
    "11206": ["Brooklyn"],
    "11211": ["Brooklyn"],
    "11222": ["Brooklyn"],
    "11249": ["Brooklyn"],
    "11102": ["Astoria", "Long Island City"],
    "11103": ["Astoria"],
    "11105": ["Astoria"],
    "11106": ["Astoria"],
    "11427": ["Hollis Hills"],
    "11370": ["East Elmhurst"],
    "11374": ["Rego Park"],
}

# Official AMI brackets, per HPD's own field descriptions on the dataset.
# Scoped to just Low and Moderate Income per the ask -- Extremely Low/Very
# Low/Middle Income and "other_income_units" (superintendent-reserved
# units) are excluded.
TIERS = [
    ("low_income_units", "Low Income", "51-80% AMI"),
    ("moderate_income_units", "Moderate Income", "81-120% AMI"),
]

PIP_URL = "https://propertyinformationportal.nyc.gov/parcels/parcel/{bbl}"


def neighborhood_label(zip_code):
    labels = ZIP_TO_NEIGHBORHOODS.get(zip_code)
    return " / ".join(labels) if labels else zip_code


def fetch_rows():
    zips_clause = ",".join(f"'{z}'" for z in ZIP_TO_NEIGHBORHOODS)
    params = {
        "$where": f"postcode in({zips_clause})",
        "$limit": 5000,
    }
    url = SOCRATA_URL + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url) as resp:
        return json.loads(resp.read().decode())


def main():
    rows = fetch_rows()

    neighborhood_stats = defaultdict(lambda: {"buildings": 0, "units": defaultdict(int)})
    buildings = []

    for row in rows:
        zip_code = row.get("postcode")
        if zip_code not in ZIP_TO_NEIGHBORHOODS:
            continue

        units_by_tier = {}
        total_tiered = 0
        for field, label, _ in TIERS:
            n = int(row.get(field) or 0)
            if n:
                units_by_tier[label] = n
                total_tiered += n
        if total_tiered == 0:
            continue  # no income-restricted units reported for this building

        stats = neighborhood_stats[zip_code]
        stats["buildings"] += 1
        for label, n in units_by_tier.items():
            stats["units"][label] += n

        bbl = row.get("bbl")
        buildings.append({
            "project_name": row.get("project_name"),
            "address": f"{row.get('house_number','').strip()} {row.get('street_name','').strip()}".strip(),
            "zip": zip_code,
            "neighborhood": neighborhood_label(zip_code),
            "units_by_tier": units_by_tier,
            "total_income_restricted_units": total_tiered,
            "total_units": int(row.get("total_units") or 0) or None,
            "bbl": bbl,
            "portal_url": PIP_URL.format(bbl=bbl) if bbl else None,
        })

    buildings.sort(key=lambda b: b["total_income_restricted_units"], reverse=True)

    neighborhoods_out = []
    for zip_code, stats in sorted(neighborhood_stats.items()):
        neighborhoods_out.append({
            "zip": zip_code,
            "neighborhood": neighborhood_label(zip_code),
            "buildings": stats["buildings"],
            "units_by_tier": dict(stats["units"]),
        })

    output = {
        "tiers": [{"label": label, "ami_range": ami} for _, label, ami in TIERS],
        "neighborhoods": neighborhoods_out,
        "buildings": buildings,
    }

    with open(OUT_PATH, "w") as f:
        json.dump(output, f, indent=2)

    total_units = sum(b["total_income_restricted_units"] for b in buildings)
    print(f"Wrote {OUT_PATH}: {len(buildings)} buildings, {total_units} income-restricted units.")


if __name__ == "__main__":
    main()
