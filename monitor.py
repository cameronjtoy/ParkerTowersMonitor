#!/usr/bin/env python3
import json
import logging
import os
import random
import smtplib
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from email.mime.text import MIMEText
from pathlib import Path
from zoneinfo import ZoneInfo

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
STATE_PATH = BASE_DIR / "seen_units.json"
LOG_PATH = BASE_DIR / "monitor.log"

API_URL = "https://units.stuytown.com/api/units"
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


def send_sms(config, body):
    msg = MIMEText(body)
    msg["Subject"] = ""
    msg["From"] = config["gmail_address"]
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


def fetch_subscriber_gateways(config):
    if not config.get("supabase_url") or not config.get("supabase_service_key"):
        return []
    try:
        rows = supabase_request(
            config, "GET", "/rest/v1/subscribers?select=gateway_email&active=eq.true"
        ) or []
        return [r["gateway_email"] for r in rows]
    except Exception as e:
        logging.error("fetching subscribers failed: %s", e)
        return []


def sync_to_supabase(config, units):
    if not config.get("supabase_url") or not config.get("supabase_service_key"):
        return

    try:
        rows = [unit_to_row(u) for u in units]
        supabase_request(
            config, "POST", "/rest/v1/listings", body=rows,
            extra_headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
        )

        current_ids = {r["id"] for r in rows}
        active_rows = supabase_request(config, "GET", "/rest/v1/listings?select=id&active=eq.true") or []
        delisted_ids = [r["id"] for r in active_rows if r["id"] not in current_ids]

        if delisted_ids:
            id_list = ",".join(delisted_ids)
            supabase_request(
                config, "PATCH", f"/rest/v1/listings?id=in.({id_list})",
                body={"active": False}, extra_headers={"Prefer": "return=minimal"},
            )
        logging.info(
            "supabase sync: %d rows upserted, %d marked delisted",
            len(rows), len(delisted_ids),
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

    subscriber_gateways = fetch_subscriber_gateways(config)
    if subscriber_gateways:
        config["sms_gateway_addresses"] = list(set(config["sms_gateway_addresses"]) | set(subscriber_gateways))
        logging.info("added %d subscriber(s) from Supabase", len(subscriber_gateways))

    try:
        data = fetch_units()
    except Exception as e:
        logging.error("fetch failed: %s", e)
        return

    units = data.get("unitModels", [])
    sync_to_supabase(config, units)

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

    # keep previously-notified units still qualifying, plus any newly-notified ones;
    # drop anything no longer qualifying so a relisted unit alerts again later
    new_seen = {spk: True for spk in qualifying_spks if spk in seen or spk in notified_spks}
    save_seen(new_seen)

    logging.info(
        "run complete: %d total units, %d qualifying, %d new notifications",
        len(units), len(qualifying), len(new_units),
    )


if __name__ == "__main__":
    main()
