"""Aggregate NYC HPD's "Buildings Subject to HPD Jurisdiction" CSV export
into a small static JSON file for docs/analytics.html.

Re-download the source CSV from NYC Open Data ("Buildings Subject to HPD
Jurisdiction", dataset id kj4p-ruqc) if it needs refreshing -- it's ~65MB /
380k rows, too large to commit or ship to the browser directly, so this
script reduces it to per-neighborhood aggregates plus a short list of
multi-building "complexes" and writes only that.

Usage: python3 analyze_hpd_buildings.py [path/to/hpd_buildings.csv]
"""
import csv
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone

DEFAULT_CSV = "Buildings_Subject_to_HPD_Jurisdiction_20260913.csv"
OUT_PATH = "docs/hpd_complexes.json"

# Zip -> neighborhood label(s), cross-referenced against the addresses
# already present in housing_listings so this matches the For Sale tab's
# city filter exactly. A zip can carry more than one label since Redfin's
# reported neighborhood name for the same zip isn't always consistent.
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

MAX_ADDRESSES_PER_COMPLEX = 8


def neighborhood_label(zip_code):
    labels = ZIP_TO_NEIGHBORHOODS.get(zip_code)
    return " / ".join(labels) if labels else zip_code


def main():
    csv_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CSV

    by_registration = defaultdict(list)
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("Zip") not in ZIP_TO_NEIGHBORHOODS:
                continue
            if row.get("RecordStatus") != "Active":
                continue
            if row.get("LifeCycle") != "Building":
                continue
            by_registration[row["RegistrationID"]].append(row)

    neighborhood_stats = defaultdict(lambda: {
        "buildings": 0,
        "complexes": 0,
        "management_programs": defaultdict(int),
    })
    for reg_id, rows in by_registration.items():
        for row in rows:
            zip_code = row["Zip"]
            stats = neighborhood_stats[zip_code]
            stats["buildings"] += 1
            stats["management_programs"][row.get("ManagementProgram") or "UNDEFINED"] += 1

    complexes = []
    for reg_id, rows in by_registration.items():
        # RegistrationID "0"/blank is a data placeholder for unregistered
        # singleton buildings, not one giant real complex -- and a group of
        # one building isn't a "complex" either.
        if reg_id in ("0", "") or len(rows) < 2:
            continue

        zip_code = rows[0]["Zip"]
        programs = [r.get("ManagementProgram") or "UNDEFINED" for r in rows]
        non_pvt = [p for p in programs if p != "PVT"]
        management_program = non_pvt[0] if non_pvt else "PVT"

        stories = [float(r["LegalStories"]) for r in rows if r.get("LegalStories")]
        avg_stories = round(sum(stories) / len(stories), 1) if stories else None

        addresses = sorted({
            f"{r['HouseNumber'].strip()} {r['StreetName'].strip()}".strip()
            for r in rows
        })

        complexes.append({
            "registration_id": reg_id,
            "zip": zip_code,
            "neighborhood": neighborhood_label(zip_code),
            "building_count": len(rows),
            "management_program": management_program,
            "avg_stories": avg_stories,
            "addresses": addresses[:MAX_ADDRESSES_PER_COMPLEX],
            "addresses_truncated": len(addresses) > MAX_ADDRESSES_PER_COMPLEX,
        })

    complexes.sort(key=lambda c: c["building_count"], reverse=True)

    neighborhoods_out = []
    for zip_code, stats in sorted(neighborhood_stats.items()):
        neighborhoods_out.append({
            "zip": zip_code,
            "neighborhood": neighborhood_label(zip_code),
            "buildings": stats["buildings"],
            "complexes": sum(1 for c in complexes if c["zip"] == zip_code),
            "management_programs": dict(stats["management_programs"]),
        })

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_csv": csv_path,
        "neighborhoods": neighborhoods_out,
        "complexes": complexes,
    }

    with open(OUT_PATH, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote {OUT_PATH}: {len(complexes)} complexes across {len(neighborhoods_out)} neighborhoods.")


if __name__ == "__main__":
    main()
