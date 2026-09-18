#!/usr/bin/env python3
import json
import logging
import os
import random
import re
import smtplib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.mime.text import MIMEText
from pathlib import Path
from zoneinfo import ZoneInfo

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
STATE_PATH = BASE_DIR / "seen_units.json"
LOG_PATH = BASE_DIR / "monitor.log"


# The endpoint paginates and silently defaults to itemsOnPage=21 -- with no
# page-size param it was only ever returning the cheapest 21 units across the
# *entire* portfolio (Stuy Town/PCV/Parker Towers/Kips Bay/8 Spruce combined),
# not "all currently available units". That caused real, still-listed units
# to drop off the page whenever pricing shuffled them out of the global top
# 21 and get falsely marked delisted. Full portfolio inventory is ~238 units;
# itemsOnPage is set well above that so every property's full inventory
# always comes back in one page.
API_URL = "https://units.stuytown.com/api/units?page=0&itemsOnPage=500"

# Both of these are single-building sites (not part of the Stuy Town feed)
# that render their availability table server-side via WordPress's own REST
# API -- fetching wp-json/wp/v2/pages/<id> returns the same rendered HTML as
# the page itself, without needing a JS-executing browser, so a plain
# urllib GET + regex is enough (the table markup isn't present in the raw
# page HTML at all -- it's injected client-side -- but the REST endpoint
# returns the server-rendered version of the same block).
MIRAMAR_API_URL = "https://rentmiramar.com/wp-json/wp/v2/pages/31"
MIRAMAR_ADDRESS = "407 West 206th Street, New York, NY 10034"
DWTNBK_API_URL = "https://dwtnbk.com/wp-json/wp/v2/pages/268"
DWTNBK_ADDRESS = "67 Prince Street, Brooklyn, NY 11201"

# LeFrak City (Corona, Queens) is a huge multi-building complex with its own
# unauthenticated AJAX endpoint that returns an HTML fragment per available
# unit -- no JS execution needed, verified with a plain POST. Each unit
# names its own sub-building (Brisbane, London, Singapore, etc, listed on
# the site's own building filter), which becomes part of the property name
# below so the site's existing per-property filter can distinguish them.
LEFRAK_API_URL = "https://www.lefrakcity.com/ajax/getunitlist.asp"
LEFRAK_PAGE_URL = "https://www.lefrakcity.com/apartments-for-rent-queens-nyc/"
LEFRAK_CITY_STATE_ZIP = "Corona, NY 11373"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
LOCAL_TZ = ZoneInfo("America/New_York")
ACTIVE_START_HOUR = 6
ACTIVE_END_HOUR = 10  # exclusive

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.FileHandler(LOG_PATH), logging.StreamHandler(sys.stdout)],
)


def load_config():
    # Prefer environment variables (set as GitHub Actions secrets when run in CI);
    # fall back to a local config.json for running on a personal machine.
    if os.environ.get("GMAIL_ADDRESS"):
        config = {
            "gmail_address": os.environ["GMAIL_ADDRESS"],
            "gmail_app_password": os.environ["GMAIL_APP_PASSWORD"],
            "notify_email": os.environ["NOTIFY_EMAIL"],
            "sms_gateway_address": os.environ["SMS_GATEWAY_ADDRESS"],
            "price_threshold": int(os.environ.get("PRICE_THRESHOLD", "2200")),
        }
    else:
        with open(CONFIG_PATH) as f:
            config = json.load(f)

    gateways = config["sms_gateway_address"]
    if isinstance(gateways, str):
        gateways = [g.strip() for g in gateways.split(",") if g.strip()]
    config["sms_gateway_addresses"] = gateways

    config["supabase_url"] = os.environ.get("SUPABASE_URL", config.get("supabase_url"))
    config["supabase_service_key"] = os.environ.get("SUPABASE_SERVICE_KEY", config.get("supabase_service_key"))
    return config


def load_seen():
    if STATE_PATH.exists():
        with open(STATE_PATH) as f:
            return json.load(f)
    return {}


def save_seen(seen):
    with open(STATE_PATH, "w") as f:
        json.dump(seen, f, indent=2)


def fetch_units():
    req = urllib.request.Request(API_URL, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        if resp.status != 200:
            raise RuntimeError(f"unexpected status {resp.status}")
        return json.load(resp)


def fetch_wp_page_html(api_url):
    req = urllib.request.Request(api_url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        if resp.status != 200:
            raise RuntimeError(f"unexpected status {resp.status}")
        data = json.load(resp)
        return data["content"]["rendered"]


def fetch_miramar_units():
    html = fetch_wp_page_html(MIRAMAR_API_URL)
    pattern = re.compile(
        r'<div class="td residence">([^<]+)</div>\s*'
        r'<div class="td rent">\$([\d,]+)</div>\s*'
        r'<div class="td bedrooms">(\d+)</div>\s*'
        r'<div class="td bathrooms">(\d+)</div>'
    )
    units = []
    for unit_number, price, beds, baths in pattern.findall(html):
        units.append({
            "unitSpk": f"miramar-{unit_number}",
            "property": {"name": "Miramar"},
            "unitNumber": unit_number,
            "price": int(price.replace(",", "")),
            "bedrooms": int(beds),
            "bathrooms": int(baths),
            "sqft": None,
            "building": {"address": MIRAMAR_ADDRESS},
            "availableDate": None,
        })
    if not units:
        raise RuntimeError("miramar: parsed 0 units, page structure likely changed")
    return units


def fetch_dwtnbk_units():
    html = fetch_wp_page_html(DWTNBK_API_URL)
    # This site's builder renders each unit as "Label: \n value" blocks
    # rather than a class-per-cell table, so each unit is split out first
    # and its fields pulled independently rather than one combined regex.
    blocks = re.split(r"(?=Residence:\s*\n)", html)
    units = []
    for block in blocks[1:]:
        m_num = re.search(r"Residence:\s*\n\s*(\S+)", block)
        m_rent = re.search(r"Monthly Rent\*:\s*\n\s*\$([\d,]+)", block)
        m_bed = re.search(r"Bedroom\(s\):\s*\n\s*(\d+)", block)
        m_bath = re.search(r"Bathroom\(s\):\s*\n\s*(\d+)", block)
        if not (m_num and m_rent and m_bed and m_bath):
            continue
        unit_number = m_num.group(1)
        units.append({
            "unitSpk": f"dwtnbk-{unit_number}",
            "property": {"name": "DWTN Brooklyn"},
            "unitNumber": unit_number,
            "price": int(m_rent.group(1).replace(",", "")),
            "bedrooms": int(m_bed.group(1)),
            "bathrooms": int(m_bath.group(1)),
            "sqft": None,
            "building": {"address": DWTNBK_ADDRESS},
            "availableDate": None,
        })
    if not units:
        raise RuntimeError("dwtnbk: parsed 0 units, page structure likely changed")
    return units


def fetch_lefrak_units():
    body = urllib.parse.urlencode({
        "bedrooms": "", "priceMin": "0", "isDefaultMinPrice": "true",
        "priceMax": "99999", "isDefaultMaxPrice": "true", "buildings": "",
        "moveInDate": "", "availableNowOnly": "0", "page": "1", "lastNum": "",
        "sort": "", "numberPerPage": "",
    }).encode()
    req = urllib.request.Request(
        LEFRAK_API_URL, data=body, method="POST",
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": LEFRAK_PAGE_URL,
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        if resp.status != 200:
            raise RuntimeError(f"lefrak: unexpected status {resp.status}")
        html = resp.read().decode()

    blocks = re.split(r'(?=<div class="unit-list-item )', html)
    units = []
    for block in blocks[1:]:
        m_uid = re.search(r'data-uid="([^"]+)"', block)
        m_price = re.search(r'data-total-price="([^"]+)"', block)
        m_building = re.search(r'data-building-name="([^"]+)"', block)
        m_addr = re.search(r"<nobr>([^<]+)</nobr>", block)
        m_aria = re.search(r'aria-label="Residence ([^"]+) in ', block)
        m_beds = re.search(r"(Studio|\d+ Bedrooms?)", block)
        m_baths = re.search(r"(\d+) Bathrooms?", block)
        if not (m_uid and m_price and m_building and m_addr and m_aria and m_beds and m_baths):
            continue
        beds = 0 if m_beds.group(1) == "Studio" else int(m_beds.group(1).split()[0])
        units.append({
            "unitSpk": f"lefrak-{m_uid.group(1)}",
            "property": {"name": f"LeFrak City ({m_building.group(1)})"},
            "unitNumber": m_aria.group(1),
            "price": int(m_price.group(1).replace(",", "")),
            "bedrooms": beds,
            "bathrooms": int(m_baths.group(1)),
            "sqft": None,
            "building": {"address": f"{m_addr.group(1)}, {LEFRAK_CITY_STATE_ZIP}"},
            "availableDate": None,
        })
    # Unlike Miramar/DWTN, an empty result here is plausible on any given
    # day (current availability runs a handful of units across a huge
    # complex, and a prior check confirmed page 2 legitimately returns
    # nothing) -- so this doesn't raise on zero the way those two do.
    return units


# Prefixes used for unitSpk on units from the scraped single-building sites
# (as opposed to numeric-only unitSpk values from the Stuy Town feed) -- used
# to scope delisting checks per-source, see sync_to_supabase.
SCRAPED_SOURCE_PREFIXES = {
    "miramar": "miramar-",
    "dwtnbk": "dwtnbk-",
    "lefrak": "lefrak-",
}


def format_unit(u):
    property_name = (u.get("property") or {}).get("name", "")
    price = u.get("price")
    beds = u.get("bedrooms")
    baths = u.get("bathrooms")
    sqft = u.get("sqft")
    unit_number = u.get("unitNumber")
    address = (u.get("building") or {}).get("address", "")
    available = u.get("availableDate", "")
    return (
        f"{property_name} — Unit {unit_number} — ${price}/mo, {beds}bd/{baths}ba, {sqft} sqft\n"
        f"{address}\nAvailable: {available}"
    )


def send_email(config, subject, body):
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = config["gmail_address"]
    msg["To"] = config["notify_email"]
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(config["gmail_address"], config["gmail_app_password"])
        server.sendmail(config["gmail_address"], [config["notify_email"]], msg.as_string())


def send_sms(config, body, recipients=None):
    msg = MIMEText(body)
    msg["Subject"] = ""
    msg["From"] = config["gmail_address"]
    if recipients is None:
        recipients = config["sms_gateway_addresses"]
    msg["To"] = ", ".join(recipients)
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(config["gmail_address"], config["gmail_app_password"])
        server.sendmail(config["gmail_address"], recipients, msg.as_string())


def unit_to_row(u):
    return {
        "id": u["unitSpk"],
        "property": (u.get("property") or {}).get("name", ""),
        "unit_number": u.get("unitNumber"),
        "price": u.get("price"),
        "beds": u.get("bedrooms"),
        "baths": u.get("bathrooms"),
        "sqft": u.get("sqft"),
        "address": (u.get("building") or {}).get("address", ""),
        "available_date": u.get("availableDate"),
        "last_seen": datetime.now(timezone.utc).isoformat(),
        "active": True,
        "missed_count": 0,
    }


def supabase_request(config, method, path, body=None, extra_headers=None):
    url = config["supabase_url"].rstrip("/") + path
    headers = {
        "apikey": config["supabase_service_key"],
        "Authorization": f"Bearer {config['supabase_service_key']}",
        "Content-Type": "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def threshold_bed_key(bedrooms):
    # "0" = studio, "3" covers 3+ bedrooms (matches the docs/index.html signup form).
    if bedrooms is None:
        return None
    return str(min(int(bedrooms), 3))


def notify_subscribers_per_threshold(config, units):
    if not config.get("supabase_url") or not config.get("supabase_service_key"):
        return

    try:
        subscribers = supabase_request(
            config, "GET",
            "/rest/v1/subscribers?select=id,gateway_email,thresholds&active=eq.true",
        ) or []
    except Exception as e:
        logging.error("fetching subscribers failed: %s", e)
        return

    # A subscriber with no thresholds set hasn't configured any bed count yet --
    # nothing to alert them on.
    subscribers = [s for s in subscribers if s.get("thresholds")]
    if not subscribers:
        return

    subscriber_ids = ",".join(s["id"] for s in subscribers)
    try:
        existing = supabase_request(
            config, "GET",
            f"/rest/v1/subscriber_notifications?select=subscriber_id,unit_id&subscriber_id=in.({subscriber_ids})",
        ) or []
    except Exception as e:
        logging.error("fetching subscriber_notifications failed: %s", e)
        return
    already_notified = {(r["subscriber_id"], r["unit_id"]) for r in existing}

    sent = 0
    for u in units:
        price = u.get("price")
        bed_key = threshold_bed_key(u.get("bedrooms"))
        if price is None or bed_key is None:
            continue
        unit_id = u["unitSpk"]
        property_name = (u.get("property") or {}).get("name", "Apartment")

        for s in subscribers:
            threshold = s["thresholds"].get(bed_key)
            if threshold is None or price >= threshold:
                continue
            if (s["id"], unit_id) in already_notified:
                continue
            try:
                send_sms(
                    config,
                    f"{property_name} unit {u.get('unitNumber')} ${price}/mo now available",
                    recipients=[s["gateway_email"]],
                )
            except Exception as e:
                logging.error(
                    "sms send failed for subscriber %s, unit %s: %s", s["id"], unit_id, e
                )
                continue
            try:
                supabase_request(
                    config, "POST", "/rest/v1/subscriber_notifications?on_conflict=subscriber_id,unit_id",
                    body={"subscriber_id": s["id"], "unit_id": unit_id},
                    extra_headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
                )
            except Exception as e:
                logging.error(
                    "recording subscriber_notification failed for %s/%s: %s", s["id"], unit_id, e
                )
                continue
            sent += 1

    if sent:
        logging.info("sent %d per-threshold subscriber notification(s)", sent)


# The Stuy Town feed alone normally returns ~230-240 units; combined with
# Miramar/DWTN Brooklyn the merged list is normally ~250-280. If a run comes
# back with suspiciously few (e.g. the main feed failed and only the small
# scraped sites came through), treat it as a likely transient/partial
# response rather than trusting it enough to count misses against everything
# absent. Per-source scrape failures are additionally guarded against in
# sync_to_supabase via failed_sources, regardless of this floor.
MIN_EXPECTED_UNITS_FOR_DELISTING = 150

# A unit has to be missing from this many *consecutive* fetches before it's
# actually marked delisted. Observed in practice: the upstream feed
# occasionally omits a unit for a single run (transient/flaky response) even
# though it's still genuinely listed -- delisting on the first miss caused a
# real unit to incorrectly disappear from the site. This grace period filters
# that out while still delisting units that are actually gone.
MISS_THRESHOLD = 2


def sync_to_supabase(config, units, failed_sources=frozenset()):
    if not config.get("supabase_url") or not config.get("supabase_service_key"):
        return

    try:
        rows = [unit_to_row(u) for u in units]
        supabase_request(
            config, "POST", "/rest/v1/listings", body=rows,
            extra_headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
        )

        newly_delisted = 0
        if len(units) >= MIN_EXPECTED_UNITS_FOR_DELISTING:
            current_ids = {r["id"] for r in rows}
            active_rows = supabase_request(
                config, "GET", "/rest/v1/listings?select=id,missed_count&active=eq.true"
            ) or []
            missing_rows = [r for r in active_rows if r["id"] not in current_ids]

            # A source that failed to fetch this run contributes zero rows,
            # which would otherwise make every one of its previously-active
            # units look "missing" and start counting toward delisting --
            # exclude them so a scrape failure can't falsely delist a whole
            # building. (The Stuy Town feed doesn't need this: its own units
            # have no prefix, and MIN_EXPECTED_UNITS_FOR_DELISTING already
            # skips this whole block if it fails to return its ~230+ units.)
            for source in failed_sources:
                prefix = SCRAPED_SOURCE_PREFIXES.get(source)
                if prefix:
                    missing_rows = [r for r in missing_rows if not r["id"].startswith(prefix)]

            for r in missing_rows:
                new_missed = (r.get("missed_count") or 0) + 1
                body = {"missed_count": new_missed}
                if new_missed >= MISS_THRESHOLD:
                    body["active"] = False
                    newly_delisted += 1
                supabase_request(
                    config, "PATCH", f"/rest/v1/listings?id=eq.{r['id']}",
                    body=body, extra_headers={"Prefer": "return=minimal"},
                )
        else:
            logging.warning(
                "fetch returned only %d units (below sanity floor of %d) -- skipping delisting checks this run",
                len(units), MIN_EXPECTED_UNITS_FOR_DELISTING,
            )

        logging.info(
            "supabase sync: %d rows upserted, %d newly marked delisted",
            len(rows), newly_delisted,
        )
    except Exception as e:
        logging.error("supabase sync failed: %s", e)


def main():
    now_local = datetime.now(LOCAL_TZ)
    force_run = os.environ.get("FORCE_RUN", "").lower() == "true"
    if not force_run and not (ACTIVE_START_HOUR <= now_local.hour < ACTIVE_END_HOUR):
        logging.info("outside active window (%s local), skipping", now_local.strftime("%H:%M %Z"))
        return

    jitter = random.uniform(0, 90)
    time.sleep(jitter)

    config = load_config()
    threshold = config.get("price_threshold", 2200)

    failed_sources = set()

    try:
        data = fetch_units()
        units = data.get("unitModels", [])
    except Exception as e:
        logging.error("stuytown fetch failed: %s", e)
        units = []
        failed_sources.add("stuytown")

    try:
        units += fetch_miramar_units()
    except Exception as e:
        logging.error("miramar fetch failed: %s", e)
        failed_sources.add("miramar")

    try:
        units += fetch_dwtnbk_units()
    except Exception as e:
        logging.error("dwtnbk fetch failed: %s", e)
        failed_sources.add("dwtnbk")

    try:
        units += fetch_lefrak_units()
    except Exception as e:
        logging.error("lefrak fetch failed: %s", e)
        failed_sources.add("lefrak")

    if len(failed_sources) == 4:
        logging.error("all sources failed, nothing to do this run")
        return

    sync_to_supabase(config, units, failed_sources=failed_sources)
    notify_subscribers_per_threshold(config, units)

    qualifying = [
        u for u in units
        if u.get("price") is not None
        and u["price"] < threshold
    ]
    qualifying_spks = {u["unitSpk"] for u in qualifying}

    seen = load_seen()

    new_units = [u for u in qualifying if u["unitSpk"] not in seen]
    notified_spks = set()

    for u in new_units:
        details = format_unit(u)
        logging.info("new qualifying unit: %s", u["unitSpk"])
        ok = False
        property_name = (u.get("property") or {}).get("name", "Apartment")
        try:
            send_email(
                config,
                f"{property_name}: new unit under ${threshold}",
                f"A new apartment under ${threshold} is available:\n\n{details}",
            )
            ok = True
        except Exception as e:
            logging.error("email send failed for %s: %s", u["unitSpk"], e)
        try:
            send_sms(
                config,
                f"{property_name} unit {u.get('unitNumber')} ${u.get('price')}/mo now available",
            )
            ok = True
        except Exception as e:
            logging.error("sms send failed for %s: %s", u["unitSpk"], e)
        # only mark as seen if at least one notification actually went out,
        # so a Gmail/SMTP failure doesn't silently suppress the retry next run
        if ok:
            notified_spks.add(u["unitSpk"])

    # keep a unit's "already notified" state as long as it's still present in the
    # feed at all -- a price rising back above the threshold isn't a delisting,
    # so it shouldn't reset notification state (that would cause a duplicate
    # notification if the price dips back under threshold later). Only drop a
    # unit once it's truly gone from the feed (not seen at all this run).
    all_current_spks = {u["unitSpk"] for u in units}
    new_seen = {spk: True for spk in seen if spk in all_current_spks}
    new_seen.update({spk: True for spk in notified_spks})
    save_seen(new_seen)

    logging.info(
        "run complete: %d total units, %d qualifying, %d new notifications",
        len(units), len(qualifying), len(new_units),
    )


if __name__ == "__main__":
    main()
