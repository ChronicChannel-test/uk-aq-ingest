#!/usr/bin/env python3
"""Batch lookup PCON codes for stations with geometry but missing PCON metadata.

Requires:
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY

Optional:
- MAPIT_BASE_URL (default: https://mapit.mysociety.org)
- MAPIT_API_KEY (optional)
- UK_AQ_USER_AGENT (default: uk-aq-pcon-lookup-batch)
"""
from __future__ import annotations

import argparse
import os
import re
import time
from typing import Any, Dict, Iterable, Optional, Tuple

import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

WKT_POINT_RE = re.compile(r"POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Lookup PCON codes for stations missing PCON metadata."
    )
    parser.add_argument("--limit", type=int, default=10, help="Max stations per run.")
    parser.add_argument(
        "--max-seconds",
        type=float,
        default=240.0,
        help="Stop after this many seconds.",
    )
    parser.add_argument(
        "--sleep-seconds",
        type=float,
        default=1.0,
        help="Sleep between API calls to avoid rate limits.",
    )
    parser.add_argument(
        "--pcon-version",
        default=os.getenv("UK_AQ_PCON_VERSION", "2024"),
        help="PCON version label to store on stations.",
    )
    parser.add_argument(
        "--station-name-from-label",
        action="store_true",
        help="Fill missing station_name from label when no match is found.",
    )
    return parser.parse_args()


def geometry_to_lon_lat(geometry: Any) -> Optional[Tuple[float, float]]:
    if geometry is None:
        return None
    if isinstance(geometry, dict) and geometry.get("type") == "Point":
        coords = geometry.get("coordinates")
        if isinstance(coords, (list, tuple)) and len(coords) == 2:
            return float(coords[0]), float(coords[1])
    if isinstance(geometry, str):
        cleaned = geometry
        if cleaned.startswith("SRID=") and ";" in cleaned:
            cleaned = cleaned.split(";", 1)[1]
        match = WKT_POINT_RE.search(cleaned)
        if match:
            return float(match.group(1)), float(match.group(2))
    return None


def station_point_wkt(lon: float, lat: float) -> str:
    return f"SRID=4326;POINT({lon} {lat})"


def fetch_missing_stations(client: Any, limit: int) -> Iterable[Dict[str, Any]]:
    response = (
        client.table("stations")
        .select("id,station_name,label,geometry")
        .is_("pcon_code", "null")
        .not_.is_("geometry", "null")
        .limit(limit)
        .execute()
    )
    data = response.data if hasattr(response, "data") else None
    if isinstance(data, list):
        return data
    return []


def lookup_mapit_pcon(
    session: requests.Session,
    base_url: str,
    api_key: Optional[str],
    lon: float,
    lat: float,
) -> Optional[Dict[str, str]]:
    url = f"{base_url.rstrip('/')}/point/4326/{lon},{lat}"
    params = {"api_key": api_key} if api_key else None
    response = session.get(url, params=params, timeout=20)
    if response.status_code != 200:
        return None
    payload = response.json()
    areas = payload.get("areas") if isinstance(payload, dict) else None
    if not isinstance(areas, dict):
        return None
    allowed_types = {"WMC", "WMCQ", "WPC"}
    for area in areas.values():
        if not isinstance(area, dict):
            continue
        if area.get("type") not in allowed_types:
            continue
        codes = area.get("codes") if isinstance(area.get("codes"), dict) else {}
        gss_code = codes.get("gss") or area.get("gss_code")
        if not gss_code:
            continue
        return {"pcon_code": gss_code, "pcon_name": area.get("name", "")}
    return None


def lookup_station_name(
    client: Any,
    lon: float,
    lat: float,
    cache: Dict[str, Optional[str]],
) -> Optional[str]:
    key = f"{lon:.6f},{lat:.6f}"
    if key in cache:
        return cache[key]
    response = client.rpc(
        "uk_aq_station_name_for_point",
        {"target_point": station_point_wkt(lon, lat)},
    ).execute()
    name = None
    if hasattr(response, "data"):
        name = response.data if isinstance(response.data, str) else None
    cache[key] = name
    return name


def update_station(
    client: Any,
    station_id: int,
    payload: Dict[str, Any],
) -> None:
    client.table("stations").update(payload).eq("id", station_id).execute()


def main() -> int:
    args = parse_args()
    supabase_url = os.getenv("SUPABASE_URL")
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        raise SystemExit("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")

    mapit_base = os.getenv("MAPIT_BASE_URL", "https://mapit.mysociety.org")
    mapit_key = os.getenv("MAPIT_API_KEY")
    user_agent = os.getenv("UK_AQ_USER_AGENT", "uk-aq-pcon-lookup-batch")

    client = create_client(supabase_url, service_key)
    session = requests.Session()
    session.headers.update({"User-Agent": user_agent})

    start = time.monotonic()
    stations = list(fetch_missing_stations(client, max(1, args.limit)))
    if not stations:
        print("No stations missing PCON codes.")
        return 0

    name_cache: Dict[str, Optional[str]] = {}
    pcon_cache: Dict[str, Optional[Dict[str, str]]] = {}
    updated = 0

    for station in stations:
        if time.monotonic() - start > args.max_seconds:
            print("Stopping early due to max runtime.")
            break
        geometry = station.get("geometry")
        coords = geometry_to_lon_lat(geometry)
        if coords is None:
            continue
        lon, lat = coords
        cache_key = f"{lon:.6f},{lat:.6f}"
        if cache_key not in pcon_cache:
            pcon_cache[cache_key] = lookup_mapit_pcon(
                session, mapit_base, mapit_key, lon, lat
            )
        pcon = pcon_cache[cache_key]
        if not pcon:
            continue

        station_name = station.get("station_name")
        if not station_name:
            station_name = lookup_station_name(client, lon, lat, name_cache)
        if not station_name and args.station_name_from_label:
            station_name = station.get("label")

        update_payload: Dict[str, Any] = {
            "pcon_code": pcon["pcon_code"],
            "pcon_version": args.pcon_version,
        }
        if station_name:
            update_payload["station_name"] = station_name

        update_station(client, station["id"], update_payload)
        updated += 1
        if args.sleep_seconds:
            time.sleep(max(0.0, args.sleep_seconds))

    print(f"Updated {updated} station(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
