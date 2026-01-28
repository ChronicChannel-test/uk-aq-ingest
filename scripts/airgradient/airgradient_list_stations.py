#!/usr/bin/env python3
"""
Fetch AirGradient locations and optionally upsert to Supabase.

Examples:
  python3 scripts/airgradient/airgradient_list_stations.py
  python3 scripts/airgradient/airgradient_list_stations.py --format csv --output airgradient_stations.csv
  python3 scripts/airgradient/airgradient_list_stations.py --to-supabase
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

from scripts.ingest_helpers import station_coords, station_in_bbox_or_missing_coords
from scripts.uk_aq_supabase import SupabaseSchemas, create_supabase_client

load_dotenv()

LOG = logging.getLogger("airgradient_stations")
DEFAULT_LOG_LEVEL = os.getenv("AIRGRADIENT_LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, DEFAULT_LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(message)s",
)
logging.getLogger("httpx").setLevel(getattr(logging, DEFAULT_LOG_LEVEL, logging.INFO))
logging.getLogger("postgrest").setLevel(getattr(logging, DEFAULT_LOG_LEVEL, logging.INFO))

AIRGRADIENT_BASE_URL = (
    os.getenv("AIRGRADIENT_BASE_URL") or "https://api.airgradient.com/public/api/v1"
).rstrip("/")
AIRGRADIENT_LOCATIONS_PATH = os.getenv("AIRGRADIENT_LOCATIONS_PATH") or "/locations"
AIRGRADIENT_CONNECTOR_CODE = os.getenv("AIRGRADIENT_CONNECTOR_CODE") or "airgradient"
AIRGRADIENT_SERVICE_REF = os.getenv("AIRGRADIENT_SERVICE_REF") or AIRGRADIENT_CONNECTOR_CODE
AIRGRADIENT_SERVICE_LABEL = os.getenv("AIRGRADIENT_SERVICE_LABEL") or "AirGradient"
AIRGRADIENT_USER_AGENT = os.getenv("AIRGRADIENT_USER_AGENT", "uk-air-quality-networks")
AIRGRADIENT_API_KEY = (os.getenv("AIRGRADIENT_API_KEY") or "").strip()
AIRGRADIENT_API_KEY_PARAM = os.getenv("AIRGRADIENT_API_KEY_PARAM") or "api_key"
AIRGRADIENT_API_KEY_HEADER = os.getenv("AIRGRADIENT_API_KEY_HEADER") or "X-API-KEY"

UK_BBOX = {
    "west": -11.0,
    "south": 49.0,
    "east": 2.0,
    "north": 61.0,
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _clean_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_locations(payload: Any) -> List[Dict[str, Any]]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        for key in ("locations", "data", "items"):
            if isinstance(payload.get(key), list):
                return [row for row in payload.get(key) if isinstance(row, dict)]
    return []


def _location_metadata(location: Dict[str, Any]) -> Dict[str, Any]:
    attributes: Dict[str, Any] = {}
    for key, target in (
        ("address", "address"),
        ("city", "city"),
        ("country", "country"),
        ("timezone", "timezone"),
        ("locationType", "location_type"),
        ("type", "location_type"),
        ("status", "status"),
        ("indoor", "indoor"),
    ):
        value = location.get(key)
        if value is not None:
            attributes[target] = value
    return attributes


def normalize_station_payload(
    location: Dict[str, Any], connector_id: int
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    location_id = location.get("id") or location.get("locationId") or location.get("location_id")
    name = _clean_str(location.get("name") or location.get("label") or location.get("title"))
    station_stub = {
        "properties": {
            "longitude": location.get("longitude") or location.get("lon") or location.get("lng"),
            "latitude": location.get("latitude") or location.get("lat"),
        }
    }
    lon_val, lat_val = station_coords(station_stub, bbox=UK_BBOX)
    row = {
        "station_ref": _clean_str(location_id),
        "service_ref": AIRGRADIENT_SERVICE_REF,
        "label": name or _clean_str(location_id) or "AirGradient Station",
        "station_name": name,
        "station_type": _clean_str(location.get("locationType") or location.get("type")),
        "region": _clean_str(location.get("city") or location.get("region")),
        "geometry": (
            f"SRID=4326;POINT({lon_val} {lat_val})"
            if lon_val is not None and lat_val is not None
            else None
        ),
        "first_seen_at": _clean_str(location.get("createdAt") or location.get("created_at")),
        "last_seen_at": _clean_str(location.get("updatedAt") or location.get("updated_at")),
        "removed_at": _clean_str(location.get("removedAt") or location.get("removed_at")),
        "connector_id": connector_id,
    }
    return row, _location_metadata(location)


class AirGradientClient:
    def __init__(self, base_url: str = AIRGRADIENT_BASE_URL, timeout: int = 60, retries: int = 3):
        self.base_url = base_url
        self.timeout = timeout
        self.retries = retries
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": AIRGRADIENT_USER_AGENT})
        if AIRGRADIENT_API_KEY and AIRGRADIENT_API_KEY_HEADER:
            self.session.headers.update({AIRGRADIENT_API_KEY_HEADER: AIRGRADIENT_API_KEY})

    def _auth_params(self) -> Dict[str, Any]:
        if AIRGRADIENT_API_KEY and AIRGRADIENT_API_KEY_PARAM:
            return {AIRGRADIENT_API_KEY_PARAM: AIRGRADIENT_API_KEY}
        return {}

    def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        url = f"{self.base_url}/{path.lstrip('/')}"
        query = dict(self._auth_params())
        if params:
            query.update(params)
        for attempt in range(1, self.retries + 1):
            try:
                resp = self.session.get(url, params=query, timeout=self.timeout)
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

    def list_locations(self) -> List[Dict[str, Any]]:
        payload = self.get(AIRGRADIENT_LOCATIONS_PATH)
        locations = _normalize_locations(payload)
        LOG.info("Fetched %s locations from AirGradient.", len(locations))
        return locations


class SupabaseWriter:
    def __init__(self) -> None:
        self.client: Client = create_supabase_client()
        schemas = SupabaseSchemas.from_client(self.client)
        self.core = schemas.core

    def upsert_connector(self) -> int:
        payload = {
            "connector_code": AIRGRADIENT_CONNECTOR_CODE,
            "label": AIRGRADIENT_SERVICE_LABEL,
            "display_name": AIRGRADIENT_SERVICE_LABEL,
            "service_url": AIRGRADIENT_BASE_URL,
            "overwrite_station_name": False,
            "stations_bbox_supported": False,
            "timeseries_station_filter_supported": False,
        }
        self.core.table("connectors").upsert(payload, on_conflict="connector_code").execute()
        row = (
            self.core.table("connectors")
            .select("id")
            .eq("connector_code", AIRGRADIENT_CONNECTOR_CODE)
            .single()
            .execute()
        )
        data = row.data if hasattr(row, "data") else row.get("data")
        if not data:
            raise RuntimeError("Failed to resolve connector id for AirGradient.")
        return int(data["id"])

    def upsert_stations(self, rows: Iterable[Dict[str, Any]]) -> int:
        payload = [row for row in rows if row.get("station_ref")]
        if not payload:
            return 0
        self.core.table("stations").upsert(
            payload, on_conflict="connector_id,service_ref,station_ref"
        ).execute()
        return len(payload)

    def fetch_station_ids_by_ref(
        self, connector_id: int, service_ref: str, station_refs: Iterable[str]
    ) -> Dict[str, int]:
        refs = [str(ref) for ref in station_refs if ref]
        if not refs:
            return {}
        mapping: Dict[str, int] = {}
        for chunk in chunked(refs, 200):
            resp = (
                self.core.table("stations")
                .select("id,station_ref")
                .eq("connector_id", connector_id)
                .eq("service_ref", str(service_ref))
                .in_("station_ref", list(chunk))
                .execute()
            )
            rows = resp.data if hasattr(resp, "data") else resp.get("data")
            for row in rows or []:
                mapping[str(row["station_ref"])] = int(row["id"])
        return mapping

    def fetch_station_metadata(self, station_ids: Iterable[int]) -> Dict[int, Dict[str, Any]]:
        ids = [str(val) for val in station_ids if val]
        if not ids:
            return {}
        metadata: Dict[int, Dict[str, Any]] = {}
        for chunk in chunked(ids, 200):
            resp = (
                self.core.table("station_metadata")
                .select("station_id,attributes")
                .in_("station_id", list(chunk))
                .execute()
            )
            rows = resp.data if hasattr(resp, "data") else resp.get("data")
            for row in rows or []:
                try:
                    station_id = int(row.get("station_id"))
                except (TypeError, ValueError):
                    continue
                attributes = row.get("attributes") or {}
                if isinstance(attributes, dict):
                    metadata[station_id] = attributes
        return metadata

    def upsert_station_metadata(self, attributes_by_station: Dict[int, Dict[str, Any]]) -> int:
        if not attributes_by_station:
            return 0
        existing = self.fetch_station_metadata(attributes_by_station.keys())
        rows = []
        timestamp = utcnow().isoformat()
        for station_id, attributes in attributes_by_station.items():
            merged = dict(existing.get(station_id, {}))
            merged.update(attributes)
            if not merged:
                continue
            rows.append(
                {"station_id": station_id, "attributes": merged, "updated_at": timestamp}
            )
        if rows:
            self.core.table("station_metadata").upsert(rows, on_conflict="station_id").execute()
        return len(rows)


def _filter_by_bbox(stations: List[Dict[str, Any]], skip_bbox: bool) -> List[Dict[str, Any]]:
    if skip_bbox:
        return stations
    filtered = []
    for location in stations:
        station_stub = {
            "properties": {
                "longitude": location.get("longitude") or location.get("lon") or location.get("lng"),
                "latitude": location.get("latitude") or location.get("lat"),
            }
        }
        if station_in_bbox_or_missing_coords(station_stub, UK_BBOX):
            filtered.append(location)
    return filtered


def _write_csv(output: str, rows: Iterable[Dict[str, Any]]) -> None:
    fieldnames = [
        "station_ref",
        "label",
        "station_name",
        "station_type",
        "region",
        "longitude",
        "latitude",
        "first_seen_at",
        "last_seen_at",
        "removed_at",
    ]
    with open(output, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def _write_json(output: Optional[str], rows: Iterable[Dict[str, Any]]) -> None:
    payload = list(rows)
    if output:
        with open(output, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        return
    print(json.dumps(payload, indent=2))


def chunked(items: Iterable[Any], size: int) -> Iterable[List[Any]]:
    batch: List[Any] = []
    for item in items:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def _output_rows(locations: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows = []
    for location in locations:
        location_id = location.get("id") or location.get("locationId") or location.get("location_id")
        station_stub = {
            "properties": {
                "longitude": location.get("longitude") or location.get("lon") or location.get("lng"),
                "latitude": location.get("latitude") or location.get("lat"),
            }
        }
        lon, lat = station_coords(station_stub, bbox=UK_BBOX)
        rows.append(
            {
                "station_ref": _clean_str(location_id),
                "label": _clean_str(location.get("name") or location.get("label") or location.get("title")),
                "station_name": _clean_str(location.get("name") or location.get("label") or location.get("title")),
                "station_type": _clean_str(location.get("locationType") or location.get("type")),
                "region": _clean_str(location.get("city") or location.get("region")),
                "longitude": lon,
                "latitude": lat,
                "first_seen_at": _clean_str(location.get("createdAt") or location.get("created_at")),
                "last_seen_at": _clean_str(location.get("updatedAt") or location.get("updated_at")),
                "removed_at": _clean_str(location.get("removedAt") or location.get("removed_at")),
            }
        )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch AirGradient locations.")
    parser.add_argument("--format", choices=("json", "csv"), default="json")
    parser.add_argument("--output", help="Output file path (defaults to stdout for JSON).")
    parser.add_argument("--to-supabase", action="store_true", help="Upsert stations into Supabase.")
    parser.add_argument("--no-filter", action="store_true", help="Skip UK bounding box filter.")
    parser.add_argument(
        "--skip-station-metadata",
        action="store_true",
        help="Skip station_metadata upserts when writing to Supabase.",
    )
    args = parser.parse_args()

    if not AIRGRADIENT_API_KEY:
        raise SystemExit("AIRGRADIENT_API_KEY is required.")

    client = AirGradientClient()
    locations = _filter_by_bbox(client.list_locations(), args.no_filter)
    LOG.info("Filtered to %s locations after bbox check.", len(locations))

    output_rows = _output_rows(locations)
    if args.format == "csv":
        if not args.output:
            raise SystemExit("--output is required when using --format csv.")
        _write_csv(args.output, output_rows)
    else:
        _write_json(args.output, output_rows)

    if args.to_supabase:
        writer = SupabaseWriter()
        connector_id = writer.upsert_connector()
        station_payloads = []
        metadata_by_ref: Dict[str, Dict[str, Any]] = {}
        for location in locations:
            station_row, metadata = normalize_station_payload(location, connector_id)
            if station_row.get("station_ref"):
                station_payloads.append(station_row)
                if metadata:
                    metadata_by_ref[str(station_row["station_ref"])] = metadata
        updated = writer.upsert_stations(station_payloads)
        LOG.info("Upserted %s stations.", updated)
        if metadata_by_ref and not args.skip_station_metadata:
            station_ids = writer.fetch_station_ids_by_ref(
                connector_id,
                AIRGRADIENT_SERVICE_REF,
                metadata_by_ref.keys(),
            )
            attributes_by_station = {
                station_ids[ref]: attrs
                for ref, attrs in metadata_by_ref.items()
                if ref in station_ids
            }
            updated = writer.upsert_station_metadata(attributes_by_station)
            LOG.info("Upserted %s station_metadata rows.", updated)


if __name__ == "__main__":
    main()
