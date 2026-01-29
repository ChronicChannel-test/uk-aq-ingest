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

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if PROJECT_ROOT.name == "scripts":
    PROJECT_ROOT = PROJECT_ROOT.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

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
SUPABASE_DB_URL = os.getenv("SUPABASE_DB_URL") or os.getenv("DATABASE_URL")

PROVIDER_SHORTNAMES = {
    "London Air Quality Network": "LAQN",
}

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


def _provider_name(location: Dict[str, Any]) -> Optional[str]:
    provider = location.get("provider") if isinstance(location.get("provider"), dict) else {}
    name = provider.get("name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    return None


def _provider_short_name(provider_name: Optional[str]) -> Optional[str]:
    if not provider_name:
        return None
    return PROVIDER_SHORTNAMES.get(provider_name, provider_name)


def _station_name(location: Dict[str, Any]) -> Optional[str]:
    name = _location_name(location)
    provider = _provider_short_name(_provider_name(location))
    if name and provider:
        return f"{provider} {name}"
    return name


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


class DbWriter:
    def __init__(self, dsn: str) -> None:
        try:
            import psycopg2  # type: ignore
            from psycopg2.extras import execute_values  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "psycopg2 is required for --to-supabase. Install psycopg2-binary."
            ) from exc
        self._psycopg2 = psycopg2
        self._execute_values = execute_values
        self.conn = psycopg2.connect(dsn)

    def close(self) -> None:
        if self.conn:
            self.conn.close()

    def upsert_connector(self) -> Tuple[int, bool]:
        with self.conn, self.conn.cursor() as cursor:
            cursor.execute(
                """
                select id, poll_enabled, overwrite_station_name
                from uk_aq_core.connectors
                where connector_code = %s
                limit 1
                """,
                (OPENAQ_CONNECTOR_CODE,),
            )
            row = cursor.fetchone()
            poll_enabled = bool(row[1]) if row else False
            overwrite_station_name = True
            cursor.execute(
                """
                insert into uk_aq_core.connectors (
                  connector_code,
                  label,
                  display_name,
                  service_url,
                  stations_bbox_supported,
                  timeseries_station_filter_supported,
                  overwrite_station_name,
                  poll_enabled
                )
                values (%s,%s,%s,%s,%s,%s,%s,%s)
                on conflict (connector_code) do update set
                  label = excluded.label,
                  display_name = excluded.display_name,
                  service_url = excluded.service_url,
                  stations_bbox_supported = excluded.stations_bbox_supported,
                  timeseries_station_filter_supported = excluded.timeseries_station_filter_supported,
                  overwrite_station_name = excluded.overwrite_station_name,
                  poll_enabled = excluded.poll_enabled
                """,
                (
                    OPENAQ_CONNECTOR_CODE,
                    OPENAQ_SERVICE_LABEL,
                    OPENAQ_SERVICE_LABEL,
                    OPENAQ_BASE_URL,
                    False,
                    False,
                    overwrite_station_name,
                    poll_enabled,
                ),
            )
            cursor.execute(
                """
                select id, overwrite_station_name
                from uk_aq_core.connectors
                where connector_code = %s
                """,
                (OPENAQ_CONNECTOR_CODE,),
            )
            row = cursor.fetchone()
            if not row:
                raise RuntimeError("Failed to resolve connector id for OpenAQ.")
            return int(row[0]), bool(row[1])

    def upsert_stations(
        self,
        locations: Iterable[Dict[str, Any]],
        connector_id: int,
        service_ref: str,
    ) -> int:
        rows = [_station_row(location, connector_id, service_ref) for location in locations]
        rows = [row for row in rows if row.get("station_ref")]
        if not rows:
            return 0
        values: List[Tuple[Any, ...]] = []
        for row in rows:
            values.append(
                (
                    row.get("station_ref"),
                    row.get("service_ref"),
                    row.get("label"),
                    row.get("station_name"),
                    row.get("station_type"),
                    row.get("region"),
                    row.get("geometry"),
                    row.get("connector_id"),
                    row.get("last_seen_at"),
                    row.get("removed_at"),
                )
            )
        insert_sql = """
            insert into uk_aq_core.stations (
              station_ref,
              service_ref,
              label,
              station_name,
              station_type,
              region,
              geometry,
              connector_id,
              last_seen_at,
              removed_at
            )
            values %s
            on conflict (connector_id, service_ref, station_ref) do update set
              label = excluded.label,
              station_name = excluded.station_name,
              station_type = excluded.station_type,
              region = excluded.region,
              geometry = excluded.geometry,
              last_seen_at = excluded.last_seen_at,
              removed_at = excluded.removed_at
        """
        template = (
            "(%s,%s,%s,%s,%s,%s,"
            "ST_GeogFromText(%s),"
            "%s,%s,%s)"
        )
        with self.conn, self.conn.cursor() as cursor:
            self._execute_values(cursor, insert_sql, values, template=template)
        return len(rows)


def normalize_location(location: Dict[str, Any]) -> Dict[str, Any]:
    location_id = location.get("id")
    station_ref = str(location_id) if location_id is not None else None
    name = _location_name(location)
    station_name = _station_name(location)
    provider_name = _provider_name(location)
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
        "station_name": station_name,
        "station_type": "mobile" if location.get("isMobile") else "fixed",
        "region": location.get("locality") or country.get("name"),
        "longitude": longitude,
        "latitude": latitude,
        "country_code": country.get("code"),
        "country_name": country.get("name"),
        "provider": provider_name,
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
    station_name = _station_name(location)
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
        "station_name": station_name,
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
        help="Upsert stations into Supabase (requires SUPABASE_DB_URL).",
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
        if not SUPABASE_DB_URL:
            raise RuntimeError("SUPABASE_DB_URL (or DATABASE_URL) is required for --to-supabase.")
        writer = DbWriter(SUPABASE_DB_URL)
        try:
            connector_id, _ = writer.upsert_connector()
            inserted = writer.upsert_stations(
                locations,
                connector_id,
                OPENAQ_SERVICE_REF,
            )
        finally:
            writer.close()
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
