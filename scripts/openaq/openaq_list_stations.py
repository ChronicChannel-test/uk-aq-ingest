#!/usr/bin/env python3
"""
Fetch OpenAQ locations in the UK bounding box.

Examples:
  python3 scripts/openaq/openaq_list_stations.py
  python3 scripts/openaq/openaq_list_stations.py --format csv --output uk_openaq_stations.csv
  python3 scripts/openaq/openaq_list_stations.py --to-supabase
"""

import argparse
import csv
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests
from dotenv import load_dotenv
from supabase import Client

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if PROJECT_ROOT.name == "scripts":
    PROJECT_ROOT = PROJECT_ROOT.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scripts.uk_aq_supabase import SupabaseSchemas, create_supabase_client

load_dotenv()

LOG = logging.getLogger("openaq_stations")
DEFAULT_LOG_LEVEL = os.getenv("OPENAQ_LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, DEFAULT_LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(message)s",
)
logging.getLogger("httpx").setLevel(getattr(logging, DEFAULT_LOG_LEVEL, logging.INFO))
logging.getLogger("postgrest").setLevel(getattr(logging, DEFAULT_LOG_LEVEL, logging.INFO))

OPENAQ_BASE_URL = (os.getenv("OPENAQ_BASE_URL") or "https://api.openaq.org/v3").rstrip("/")
OPENAQ_API_KEY = (os.getenv("OPENAQ_API_KEY") or "").strip()
OPENAQ_CONNECTOR_CODE = os.getenv("OPENAQ_CONNECTOR_CODE") or "openaq"
OPENAQ_SERVICE_REF = os.getenv("OPENAQ_SERVICE_REF") or OPENAQ_CONNECTOR_CODE
OPENAQ_SERVICE_LABEL = os.getenv("OPENAQ_SERVICE_LABEL") or "OpenAQ"
OPENAQ_USER_AGENT = os.getenv("OPENAQ_USER_AGENT") or "uk-air-quality-networks"
OPENAQ_BBOX = os.getenv("OPENAQ_BBOX") or "-8.623555,49.863222,1.763337,60.871222"
OPENAQ_PAGE_LIMIT = int(os.getenv("OPENAQ_PAGE_LIMIT") or "1000")
OPENAQ_MAX_PAGES = int(os.getenv("OPENAQ_MAX_PAGES") or "0")

UK_BBOX = {
    "west": -8.623555,
    "south": 49.863222,
    "east": 1.763337,
    "north": 60.871222,
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def parse_bbox(value: str) -> Tuple[str, Dict[str, float]]:
    parts = [part.strip() for part in value.split(",") if part.strip()]
    if len(parts) != 4:
        raise ValueError("OPENAQ_BBOX must include west,south,east,north.")
    numbers = [float(part) for part in parts]
    bbox = {
        "west": numbers[0],
        "south": numbers[1],
        "east": numbers[2],
        "north": numbers[3],
    }
    return ",".join(str(num) for num in numbers), bbox


def coerce_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


class OpenAQClient:
    def __init__(self, base_url: str = OPENAQ_BASE_URL, timeout: int = 60, retries: int = 3) -> None:
        if not OPENAQ_API_KEY:
            raise RuntimeError("OPENAQ_API_KEY is required.")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.retries = retries
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": OPENAQ_USER_AGENT,
                "Accept": "application/json",
                "X-API-Key": OPENAQ_API_KEY,
            }
        )

    def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        url = f"{self.base_url}/{path.lstrip('/')}"
        for attempt in range(1, self.retries + 1):
            try:
                resp = self.session.get(url, params=params, timeout=self.timeout)
                if resp.status_code in (429, 500, 502, 503, 504):
                    self._sleep(attempt)
                    continue
                resp.raise_for_status()
                return resp.json()
            except requests.RequestException as exc:
                LOG.warning("Request failed (attempt %s/%s): %s", attempt, self.retries, exc)
                if attempt == self.retries:
                    raise
                self._sleep(attempt)
        return []

    def _sleep(self, attempt: int) -> None:
        time.sleep(min(30, 2**attempt))

    def list_locations(self, bbox: str, limit: int, max_pages: Optional[int]) -> List[Dict[str, Any]]:
        results: List[Dict[str, Any]] = []
        page = 1
        while True:
            payload = self.get(
                "locations",
                {
                    "bbox": bbox,
                    "limit": min(limit, 1000),
                    "page": page,
                },
            )
            page_results = payload.get("results") if isinstance(payload, dict) else []
            page_rows = page_results if isinstance(page_results, list) else []
            if not page_rows:
                break
            results.extend(page_rows)
            if len(page_rows) < min(limit, 1000):
                break
            page += 1
            if max_pages and page > max_pages:
                break
        return results


class SupabaseWriter:
    def __init__(self) -> None:
        self.client: Client = create_supabase_client()
        schemas = SupabaseSchemas.from_client(self.client)
        self.core = schemas.core

    def upsert_connector(self) -> Tuple[int, bool]:
        existing = (
            self.core.table("connectors")
            .select("id,poll_enabled,overwrite_station_name")
            .eq("connector_code", OPENAQ_CONNECTOR_CODE)
            .limit(1)
            .execute()
        )
        existing_rows = existing.data if hasattr(existing, "data") else existing.get("data")
        existing_row = (
            existing_rows[0]
            if isinstance(existing_rows, list) and existing_rows
            else existing_rows
            if isinstance(existing_rows, dict)
            else None
        )
        poll_enabled = bool(existing_row.get("poll_enabled")) if isinstance(existing_row, dict) else False
        overwrite_station_name = (
            bool(existing_row.get("overwrite_station_name")) if isinstance(existing_row, dict) else False
        )
        payload = {
            "connector_code": OPENAQ_CONNECTOR_CODE,
            "label": OPENAQ_SERVICE_LABEL,
            "display_name": OPENAQ_SERVICE_LABEL,
            "service_url": OPENAQ_BASE_URL,
            "stations_bbox_supported": False,
            "timeseries_station_filter_supported": False,
            "overwrite_station_name": overwrite_station_name,
            "poll_enabled": poll_enabled,
        }
        self.core.table("connectors").upsert(payload, on_conflict="connector_code").execute()
        row = (
            self.core.table("connectors")
            .select("id,overwrite_station_name")
            .eq("connector_code", OPENAQ_CONNECTOR_CODE)
            .single()
            .execute()
        )
        data = row.data if hasattr(row, "data") else row.get("data")
        if not data:
            raise RuntimeError("Failed to resolve connector id for OpenAQ.")
        overwrite_station_name = bool(data.get("overwrite_station_name"))
        return int(data["id"]), overwrite_station_name

    def fetch_station_names(
        self, connector_id: int, service_ref: str, station_refs: Iterable[str]
    ) -> Dict[str, Optional[str]]:
        refs = [str(ref) for ref in station_refs if ref]
        if not refs:
            return {}
        mapping: Dict[str, Optional[str]] = {}
        for chunk in chunked(refs, 200):
            resp = (
                self.core.table("stations")
                .select("station_ref,station_name")
                .eq("connector_id", connector_id)
                .eq("service_ref", str(service_ref))
                .in_("station_ref", list(chunk))
                .execute()
            )
            rows = resp.data if hasattr(resp, "data") else resp.get("data")
            for row in rows or []:
                mapping[str(row.get("station_ref"))] = row.get("station_name")
        return mapping

    def upsert_stations(
        self,
        locations: Iterable[Dict[str, Any]],
        connector_id: int,
        service_ref: str,
        overwrite_station_name: bool,
    ) -> int:
        rows = [_station_row(location, connector_id, service_ref) for location in locations]
        rows = [row for row in rows if row.get("station_ref")]
        if not rows:
            return 0
        if not overwrite_station_name:
            existing_names = self.fetch_station_names(
                connector_id,
                service_ref,
                [row.get("station_ref") for row in rows if row.get("station_ref")],
            )
            for row in rows:
                station_ref = row.get("station_ref")
                if station_ref and existing_names.get(station_ref):
                    row.pop("station_name", None)
        self.core.table("stations").upsert(
            rows,
            on_conflict="connector_id,service_ref,station_ref",
        ).execute()
        return len(rows)


def normalize_location(location: Dict[str, Any]) -> Dict[str, Any]:
    location_id = location.get("id")
    station_ref = str(location_id) if location_id is not None else None
    name = _location_name(location)
    coords = location.get("coordinates") if isinstance(location.get("coordinates"), dict) else {}
    longitude = coerce_float(coords.get("longitude"))
    latitude = coerce_float(coords.get("latitude"))
    sensors = location.get("sensors") if isinstance(location.get("sensors"), list) else []
    parameters = sorted(
        {
            str(sensor.get("parameter", {}).get("name")).strip()
            for sensor in sensors
            if isinstance(sensor, dict) and sensor.get("parameter")
        }
        - {"", "None"}
    )
    country = location.get("country") if isinstance(location.get("country"), dict) else {}
    provider = location.get("provider") if isinstance(location.get("provider"), dict) else {}
    owner = location.get("owner") if isinstance(location.get("owner"), dict) else {}
    datetime_first = location.get("datetimeFirst") if isinstance(location.get("datetimeFirst"), dict) else {}
    datetime_last = location.get("datetimeLast") if isinstance(location.get("datetimeLast"), dict) else {}
    return {
        "station_ref": station_ref,
        "label": name or (f"OpenAQ {station_ref}" if station_ref else None),
        "station_name": name,
        "station_type": "mobile" if location.get("isMobile") else "fixed",
        "region": location.get("locality") or country.get("name"),
        "longitude": longitude,
        "latitude": latitude,
        "country_code": country.get("code"),
        "country_name": country.get("name"),
        "provider": provider.get("name"),
        "owner": owner.get("name"),
        "is_monitor": location.get("isMonitor"),
        "is_mobile": location.get("isMobile"),
        "sensor_parameters": ",".join(parameters),
        "sensors_count": len(sensors),
        "datetime_first_utc": datetime_first.get("utc"),
        "datetime_last_utc": datetime_last.get("utc"),
    }


def _location_name(location: Dict[str, Any]) -> Optional[str]:
    name = location.get("name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    locality = location.get("locality")
    if isinstance(locality, str) and locality.strip():
        return locality.strip()
    return None


def _station_row(location: Dict[str, Any], connector_id: int, service_ref: str) -> Dict[str, Any]:
    location_id = location.get("id")
    station_ref = str(location_id) if location_id is not None else None
    name = _location_name(location)
    coords = location.get("coordinates") if isinstance(location.get("coordinates"), dict) else {}
    longitude = coerce_float(coords.get("longitude"))
    latitude = coerce_float(coords.get("latitude"))
    geometry = None
    if longitude is not None and latitude is not None:
        geometry = f"SRID=4326;POINT({longitude} {latitude})"
    datetime_last = location.get("datetimeLast") if isinstance(location.get("datetimeLast"), dict) else {}
    last_seen_at = datetime_last.get("utc") or utcnow().isoformat()
    country = location.get("country") if isinstance(location.get("country"), dict) else {}
    return {
        "station_ref": station_ref,
        "service_ref": str(service_ref),
        "label": name or (f"OpenAQ {station_ref}" if station_ref else None),
        "station_name": name,
        "station_type": "mobile" if location.get("isMobile") else "fixed",
        "region": location.get("locality") or country.get("name"),
        "geometry": geometry,
        "connector_id": connector_id,
        "last_seen_at": last_seen_at,
        "removed_at": None,
    }


def _write_json(path: str, payload: Dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")


def _write_csv(path: str, rows: Iterable[Dict[str, Any]]) -> None:
    rows = list(rows)
    fieldnames = [
        "station_ref",
        "label",
        "station_name",
        "station_type",
        "region",
        "longitude",
        "latitude",
        "country_code",
        "country_name",
        "provider",
        "owner",
        "is_monitor",
        "is_mobile",
        "sensor_parameters",
        "sensors_count",
        "datetime_first_utc",
        "datetime_last_utc",
    ]
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch OpenAQ locations for the UK.")
    parser.add_argument(
        "--output",
        default="openaq_stations.json",
        help="Output file path (default: openaq_stations.json).",
    )
    parser.add_argument(
        "--format",
        choices=("json", "csv"),
        default="json",
        help="Output format (json or csv).",
    )
    parser.add_argument(
        "--bbox",
        default=OPENAQ_BBOX,
        help="Override bbox as west,south,east,north (default: OPENAQ_BBOX).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=OPENAQ_PAGE_LIMIT,
        help="OpenAQ page size (default: OPENAQ_PAGE_LIMIT).",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=OPENAQ_MAX_PAGES,
        help="Stop after this many pages (0 = no limit).",
    )
    parser.add_argument(
        "--raw-output",
        help="Write raw location payloads to this file (JSON only).",
    )
    parser.add_argument(
        "--to-supabase",
        action="store_true",
        help="Upsert stations into Supabase (requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    run_at = utcnow()
    bbox_str, bbox_map = parse_bbox(args.bbox)

    client = OpenAQClient()
    locations = client.list_locations(bbox_str, args.limit, args.max_pages or None)
    LOG.info("Fetched %s locations from OpenAQ.", len(locations))

    normalized = [normalize_location(location) for location in locations]
    missing_coords = sum(1 for row in normalized if row.get("longitude") is None or row.get("latitude") is None)
    LOG.info("Locations missing coords=%s", missing_coords)

    if args.to_supabase:
        writer = SupabaseWriter()
        connector_id, overwrite_station_name = writer.upsert_connector()
        inserted = writer.upsert_stations(
            locations,
            connector_id,
            OPENAQ_SERVICE_REF,
            overwrite_station_name,
        )
        LOG.info("Upserted %s stations into Supabase.", inserted)

    if args.format == "csv":
        _write_csv(args.output, normalized)
    else:
        raw_payload = None
        if args.raw_output:
            raw_payload = {
                "source": OPENAQ_BASE_URL,
                "fetched_at": run_at.isoformat(),
                "bbox": bbox_map,
                "count": len(locations),
                "locations": locations,
            }
            _write_json(args.raw_output, raw_payload)
        payload = {
            "source": OPENAQ_BASE_URL,
            "fetched_at": run_at.isoformat(),
            "bbox": bbox_map,
            "count": len(normalized),
            "connector_code": OPENAQ_CONNECTOR_CODE,
            "service_ref": OPENAQ_SERVICE_REF,
            "stations": normalized,
        }
        _write_json(args.output, payload)
    LOG.info("Wrote %s", args.output)


def chunked(values: List[str], size: int) -> Iterable[List[str]]:
    if size <= 0:
        size = 200
    for idx in range(0, len(values), size):
        yield values[idx : idx + size]


if __name__ == "__main__":
    main()
