#!/usr/bin/env python3
"""
Refresh station PCON/LA codes using Aiven PostGIS boundaries.

Requires:
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- PCON_AIVEN_PG_DSN

Optional:
- PCON_VERSION, LA_VERSION (fallbacks to latest available in Aiven)
"""

from __future__ import annotations

import argparse
import binascii
import os
import struct
import sys
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

import psycopg2
import requests
from dotenv import load_dotenv

load_dotenv()

PCON_TABLE = "pcon_boundaries"
LA_TABLE = "la_boundaries"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh station PCON/LA codes via Aiven.")
    parser.add_argument("--page-size", type=int, default=500, help="Supabase page size.")
    parser.add_argument("--limit", type=int, default=0, help="Max stations to process (0 = no limit).")
    parser.add_argument("--sleep-seconds", type=float, default=0.0, help="Sleep between updates.")
    parser.add_argument("--dry-run", action="store_true", help="Log updates without writing.")
    return parser.parse_args()


def normalize_base_url(url: str) -> str:
    return url[:-1] if url.endswith("/") else url


def supabase_headers(service_role_key: str) -> Dict[str, str]:
    core_schema = os.getenv("UK_AQ_CORE_SCHEMA", "uk_aq_core")
    return {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
        "Content-Type": "application/json",
        "Accept-Profile": core_schema,
        "Content-Profile": core_schema,
    }


def geometry_to_lon_lat(value: Any) -> Tuple[Optional[float], Optional[float]]:
    if value is None:
        return None, None
    if isinstance(value, dict):
        coords = value.get("coordinates")
        if isinstance(coords, (list, tuple)) and len(coords) >= 2:
            lon, lat = coords[0], coords[1]
            if isinstance(lon, (int, float)) and isinstance(lat, (int, float)):
                return float(lon), float(lat)
        return None, None
    if isinstance(value, str):
        try:
            raw = binascii.unhexlify(value)
        except (binascii.Error, ValueError):
            return None, None
        if len(raw) < 21:
            return None, None
        endian_flag = raw[0]
        if endian_flag == 0:
            endian = ">"
        elif endian_flag == 1:
            endian = "<"
        else:
            return None, None
        offset = 1
        try:
            geom_type = struct.unpack(f"{endian}I", raw[offset:offset + 4])[0]
        except struct.error:
            return None, None
        offset += 4
        has_srid = bool(geom_type & 0x20000000)
        base_type = geom_type & 0xFF
        if base_type != 1:
            return None, None
        if has_srid:
            if len(raw) < offset + 4:
                return None, None
            offset += 4
        if len(raw) < offset + 16:
            return None, None
        try:
            x, y = struct.unpack(f"{endian}dd", raw[offset:offset + 16])
        except struct.error:
            return None, None
        return float(x), float(y)
    return None, None


def fetch_station_batch(
    url: str,
    headers: Dict[str, str],
    last_id: Optional[int],
    page_size: int,
) -> List[Dict[str, Any]]:
    params = {
        "select": "id,geometry,pcon_code,la_code",
        "order": "id",
        "limit": str(page_size),
        "geometry": "not.is.null",
        "or": "(pcon_code.is.null,la_code.is.null)",
    }
    if last_id is not None:
        params["id"] = f"gt.{last_id}"
    resp = requests.get(url, headers=headers, params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, list):
        return []
    return data


def patch_station(
    url: str,
    headers: Dict[str, str],
    station_id: int,
    payload: Dict[str, Any],
) -> None:
    resp = requests.patch(
        url,
        headers=headers,
        params={"id": f"eq.{station_id}"},
        json=payload,
        timeout=30,
    )
    resp.raise_for_status()


def resolve_latest_version(conn: psycopg2.extensions.connection, table: str, column: str) -> Optional[str]:
    with conn.cursor() as cursor:
        cursor.execute(
            f"select {column} from {table} where {column} is not null order by {column} desc limit 1"
        )
        row = cursor.fetchone()
    if not row:
        return None
    return str(row[0]) if row[0] is not None else None


def lookup_code(
    cursor: psycopg2.extensions.cursor,
    table: str,
    code_field: str,
    version_field: str,
    version: str,
    lon: float,
    lat: float,
) -> Optional[str]:
    query = (
        f"select {code_field} "
        f"from {table} "
        f"where {version_field} = %s "
        f"and st_covers(geometry::geometry, st_setsrid(st_point(%s, %s), 4326)) "
        "limit 1"
    )
    cursor.execute(query, (version, lon, lat))
    row = cursor.fetchone()
    if not row:
        return None
    return str(row[0]) if row[0] is not None else None


def main() -> int:
    args = parse_args()
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    aiven_dsn = os.getenv("PCON_AIVEN_PG_DSN")
    pcon_version = os.getenv("PCON_VERSION")
    la_version = os.getenv("LA_VERSION")
    if not supabase_url or not supabase_key or not aiven_dsn:
        print("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or PCON_AIVEN_PG_DSN.", file=sys.stderr)
        return 1

    stations_url = f"{normalize_base_url(supabase_url)}/rest/v1/stations"
    headers = supabase_headers(supabase_key)

    conn = psycopg2.connect(aiven_dsn)
    conn.autocommit = True
    try:
        if not pcon_version:
            pcon_version = resolve_latest_version(conn, PCON_TABLE, "pcon_version")
        if not la_version:
            la_version = resolve_latest_version(conn, LA_TABLE, "la_version")
        if not pcon_version or not la_version:
            print("Missing PCON_VERSION or LA_VERSION and failed to resolve from Aiven.", file=sys.stderr)
            return 1

        print(f"Using PCON_VERSION={pcon_version} LA_VERSION={la_version}")

        last_id: Optional[int] = None
        processed = 0
        updated = 0
        missing_coords = 0
        pcon_found = 0
        la_found = 0
        pcon_missing = 0
        la_missing = 0
        errors = 0

        with conn.cursor() as cursor:
            while True:
                batch = fetch_station_batch(stations_url, headers, last_id, args.page_size)
                if not batch:
                    break
                for row in batch:
                    station_id = row.get("id")
                    if station_id is not None:
                        try:
                            last_id = int(station_id)
                        except (TypeError, ValueError):
                            pass
                    lon, lat = geometry_to_lon_lat(row.get("geometry"))
                    if lon is None or lat is None:
                        missing_coords += 1
                        continue

                    payload: Dict[str, Any] = {}
                    if row.get("pcon_code") is None:
                        code = lookup_code(
                            cursor,
                            PCON_TABLE,
                            "pcon_code",
                            "pcon_version",
                            pcon_version,
                            lon,
                            lat,
                        )
                        if code:
                            payload["pcon_code"] = code
                            payload["pcon_version"] = pcon_version
                            pcon_found += 1
                        else:
                            pcon_missing += 1

                    if row.get("la_code") is None:
                        code = lookup_code(
                            cursor,
                            LA_TABLE,
                            "la_code",
                            "la_version",
                            la_version,
                            lon,
                            lat,
                        )
                        if code:
                            payload["la_code"] = code
                            payload["la_version"] = la_version
                            la_found += 1
                        else:
                            la_missing += 1

                    if payload and station_id is not None:
                        if args.dry_run:
                            print(f"Dry-run station {station_id}: {payload}")
                        else:
                            try:
                                patch_station(stations_url, headers, station_id, payload)
                                updated += 1
                            except requests.RequestException as exc:
                                errors += 1
                                print(f"Failed to update station {station_id}: {exc}", file=sys.stderr)
                    processed += 1
                    if args.limit and processed >= args.limit:
                        break
                    if args.sleep_seconds:
                        time.sleep(max(0.0, args.sleep_seconds))

                if args.limit and processed >= args.limit:
                    break
                if len(batch) < args.page_size:
                    break

        print(
            "Stations processed:",
            processed,
            "updated:",
            updated,
            "missing_coords:",
            missing_coords,
            "pcon_found:",
            pcon_found,
            "la_found:",
            la_found,
            "pcon_missing:",
            pcon_missing,
            "la_missing:",
            la_missing,
            "errors:",
            errors,
        )
    finally:
        conn.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
