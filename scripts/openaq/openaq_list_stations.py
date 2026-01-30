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
OPENAQ_RATE_LIMIT_PER_MIN = int(os.getenv("OPENAQ_RATE_LIMIT_PER_MIN") or "60")
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


def _owner_name(location: Dict[str, Any]) -> Optional[str]:
    owner = location.get("owner")
    if isinstance(owner, str):
        return owner.strip() or None
    if isinstance(owner, dict):
        name = owner.get("name")
        if isinstance(name, str):
            return name.strip() or None
    return None


def _normalize_owner_name(owner_name: Optional[str]) -> Optional[str]:
    if not owner_name:
        return None
    trimmed = owner_name.strip()
    if not trimmed:
        return None
    if trimmed.lower().startswith("unknown"):
        return None
    return trimmed


def _station_name(location: Dict[str, Any]) -> Optional[str]:
    name = _location_name(location)
    provider = _provider_short_name(_provider_name(location))
    owner = _normalize_owner_name(_owner_name(location))
    if name and provider:
        base = f"{provider} {name}"
        return f"{base} - {owner}" if owner else base
    return name


class OpenAQClient:
    def __init__(self, base_url: str = OPENAQ_BASE_URL, timeout: int = 60, retries: int = 3) -> None:
        if not OPENAQ_API_KEY:
            raise RuntimeError("OPENAQ_API_KEY is required.")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.retries = retries
        self.last_request_at = 0.0
        self.min_interval_seconds = 0.0
        if OPENAQ_RATE_LIMIT_PER_MIN > 0:
            self.min_interval_seconds = max(0.0, 60.0 / float(OPENAQ_RATE_LIMIT_PER_MIN))
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": OPENAQ_USER_AGENT,
                "Accept": "application/json",
                "X-API-Key": OPENAQ_API_KEY,
            }
        )

    def _rate_limit_info(self, resp: requests.Response) -> Dict[str, Optional[int]]:
        def to_int(value: Optional[str]) -> Optional[int]:
            if value is None:
                return None
            try:
                return int(value)
            except (TypeError, ValueError):
                return None

        headers = resp.headers
        return {
            "limit": to_int(headers.get("x-ratelimit-limit")),
            "remaining": to_int(headers.get("x-ratelimit-remaining")),
            "reset": to_int(headers.get("x-ratelimit-reset")),
            "used": to_int(headers.get("x-ratelimit-used")),
        }

    def _rate_limit_delay_seconds(self, reset: Optional[int]) -> float:
        if reset is None:
            return 0.0
        if reset > 1e12:
            return max(0.0, reset / 1000.0 - time.time())
        if reset > 1e9:
            return max(0.0, reset - time.time())
        return max(0.0, float(reset))

    def _respect_min_interval(self) -> None:
        if self.min_interval_seconds <= 0:
            return
        elapsed = time.time() - self.last_request_at
        if elapsed < self.min_interval_seconds:
            time.sleep(self.min_interval_seconds - elapsed)

    def _maybe_sleep_for_rate_limit(self, resp: requests.Response) -> None:
        info = self._rate_limit_info(resp)
        remaining = info.get("remaining")
        reset = info.get("reset")
        if remaining is None or reset is None:
            return
        if remaining <= 1:
            delay = self._rate_limit_delay_seconds(reset)
            if delay > 0:
                LOG.info(
                    "OpenAQ rate limit low (remaining=%s). Sleeping %.1fs.",
                    remaining,
                    delay,
                )
                time.sleep(delay)

    def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        url = f"{self.base_url}/{path.lstrip('/')}"
        for attempt in range(1, self.retries + 1):
            try:
                self._respect_min_interval()
                resp = self.session.get(url, params=params, timeout=self.timeout)
                self.last_request_at = time.time()
                if resp.status_code in (429, 500, 502, 503, 504):
                    if resp.status_code == 429:
                        info = self._rate_limit_info(resp)
                        delay = self._rate_limit_delay_seconds(info.get("reset")) or min(60, 2**attempt)
                        LOG.warning(
                            "OpenAQ rate limit hit (remaining=%s). Sleeping %.1fs.",
                            info.get("remaining"),
                            delay,
                        )
                        time.sleep(delay)
                        continue
                    self._sleep(attempt)
                    continue
                resp.raise_for_status()
                self._maybe_sleep_for_rate_limit(resp)
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

    def get_poll_enabled(self) -> Optional[bool]:
        with self.conn, self.conn.cursor() as cursor:
            cursor.execute(
                """
                select poll_enabled
                from uk_aq_core.connectors
                where connector_code = %s
                limit 1
                """,
                (OPENAQ_CONNECTOR_CODE,),
            )
            row = cursor.fetchone()
            if row is None:
                return None
            return bool(row[0])

    def set_poll_enabled(self, poll_enabled: bool) -> None:
        with self.conn, self.conn.cursor() as cursor:
            cursor.execute(
                """
                update uk_aq_core.connectors
                set poll_enabled = %s
                where connector_code = %s
                """,
                (poll_enabled, OPENAQ_CONNECTOR_CODE),
            )

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
        owner_by_ref: Dict[str, str] = {}
        for location in locations:
            station_ref = str(location.get("id")) if location.get("id") is not None else None
            if not station_ref:
                continue
            owner = _normalize_owner_name(_owner_name(location))
            if owner:
                owner_by_ref[station_ref] = owner
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
            if owner_by_ref:
                station_refs = list(owner_by_ref.keys())
                cursor.execute(
                    """
                    select id, station_ref
                    from uk_aq_core.stations
                    where connector_id = %s
                      and service_ref = %s
                      and station_ref = any(%s)
                    """,
                    (connector_id, service_ref, station_refs),
                )
                id_map = {str(row[1]): int(row[0]) for row in cursor.fetchall()}
                metadata_rows = []
                for station_ref, owner in owner_by_ref.items():
                    station_id = id_map.get(station_ref)
                    if not station_id:
                        continue
                    metadata_rows.append(
                        (station_id, json.dumps({"openaq_owner": owner}), utcnow())
                    )
                if metadata_rows:
                    cursor.executemany(
                        """
                        insert into uk_aq_core.station_metadata (station_id, attributes, updated_at)
                        values (%s, %s::jsonb, %s)
                        on conflict (station_id) do update set
                          attributes = uk_aq_core.station_metadata.attributes || excluded.attributes,
                          updated_at = excluded.updated_at
                        """,
                        metadata_rows,
                    )
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
    owner_name = _normalize_owner_name(_owner_name(location))
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
        "owner": owner_name,
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
    parser.add_argument(
        "--toggle-polling",
        action="store_true",
        help="Temporarily disable connector polling while the script runs (requires --to-supabase).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    run_at = utcnow()
    bbox_str, bbox_map = parse_bbox(args.bbox)

    writer = None
    original_poll_enabled = None
    if args.to_supabase:
        if not SUPABASE_DB_URL:
            raise RuntimeError("SUPABASE_DB_URL (or DATABASE_URL) is required for --to-supabase.")
        writer = DbWriter(SUPABASE_DB_URL)
        if args.toggle_polling:
            original_poll_enabled = writer.get_poll_enabled()
            if original_poll_enabled is None:
                LOG.warning("OpenAQ connector not found; skipping poll_enabled toggle.")
            else:
                writer.set_poll_enabled(False)
                LOG.info("Disabled OpenAQ polling while listing stations.")

    try:
        client = OpenAQClient()
        locations = client.list_locations(bbox_str, args.limit, args.max_pages or None)
        LOG.info("Fetched %s locations from OpenAQ.", len(locations))

        normalized = [normalize_location(location) for location in locations]
        missing_coords = sum(
            1 for row in normalized if row.get("longitude") is None or row.get("latitude") is None
        )
        LOG.info("Locations missing coords=%s", missing_coords)

        if args.to_supabase:
            connector_id, _ = writer.upsert_connector()
            inserted = writer.upsert_stations(
                locations,
                connector_id,
                OPENAQ_SERVICE_REF,
            )
            LOG.info("Upserted %s stations into Supabase.", inserted)

        if args.format == "csv":
            _write_csv(args.output, normalized)
        else:
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
    finally:
        if writer and args.toggle_polling and original_poll_enabled is not None:
            writer.set_poll_enabled(original_poll_enabled)
            LOG.info("Restored OpenAQ polling to %s.", original_poll_enabled)
        if writer:
            writer.close()


def chunked(values: List[str], size: int) -> Iterable[List[str]]:
    if size <= 0:
        size = 200
    for idx in range(0, len(values), size):
        yield values[idx : idx + size]


if __name__ == "__main__":
    main()
