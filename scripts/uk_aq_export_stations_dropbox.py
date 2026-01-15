#!/usr/bin/env python3
"""
Export all stations from Supabase and upload a timestamped JSON file to Dropbox.
"""

from __future__ import annotations

import argparse
import binascii
import json
import os
import re
import struct
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token"
DROPBOX_UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload"

DEFAULT_PAGE_SIZE = 1000
DEFAULT_DROPBOX_DIR = "uk_aq_stations"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export stations from Supabase and upload to Dropbox."
    )
    parser.add_argument(
        "--dropbox-dir",
        default=os.getenv("UK_AQ_STATIONS_DROPBOX_DIR", DEFAULT_DROPBOX_DIR),
        help="Dropbox folder for uploads (default: uk_aq_stations).",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Optional local output path (default: ./uk_aq_stations_<timestamp>.json).",
    )
    parser.add_argument(
        "--page-size",
        type=int,
        default=DEFAULT_PAGE_SIZE,
        help="Supabase page size (default: 1000).",
    )
    return parser.parse_args()


def _dropbox_refresh_access_token() -> str:
    app_key = os.getenv("DROPBOX_APP_KEY", "").strip()
    app_secret = os.getenv("DROPBOX_APP_SECRET", "").strip()
    refresh_token = os.getenv("DROPBOX_REFRESH_TOKEN", "").strip()
    if not (app_key and app_secret and refresh_token):
        raise RuntimeError("Dropbox credentials are required.")
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": app_key,
        "client_secret": app_secret,
    }
    resp = requests.post(DROPBOX_TOKEN_URL, data=payload, timeout=30)
    if resp.status_code >= 400:
        raise RuntimeError(f"Dropbox token request failed ({resp.status_code}): {resp.text}")
    data = resp.json()
    token = data.get("access_token")
    if not token:
        raise RuntimeError("Dropbox token response missing access_token.")
    return token


def _dropbox_upload_file(access_token: str, local_path: Path, dropbox_path: str) -> None:
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Dropbox-API-Arg": json.dumps(
            {
                "path": dropbox_path,
                "mode": "add",
                "autorename": True,
                "mute": False,
            }
        ),
        "Content-Type": "application/octet-stream",
    }
    with local_path.open("rb") as handle:
        resp = requests.post(DROPBOX_UPLOAD_URL, headers=headers, data=handle, timeout=120)
    if resp.status_code >= 400:
        raise RuntimeError(f"Dropbox upload failed ({resp.status_code}): {resp.text}")


def _normalize_dropbox_path(path: str) -> str:
    cleaned = (path or "").strip()
    if not cleaned:
        return ""
    if not cleaned.startswith("/"):
        cleaned = f"/{cleaned}"
    return cleaned.rstrip("/")


def _dropbox_root_folder() -> str:
    return _normalize_dropbox_path(os.getenv("UK_AIR_DROPBOX_ROOT", ""))


def _join_dropbox_paths(root: str, subdir: str) -> str:
    root_clean = _normalize_dropbox_path(root)
    sub_clean = _normalize_dropbox_path(subdir).lstrip("/")
    if not root_clean:
        return f"/{sub_clean}" if sub_clean else ""
    if not sub_clean:
        return root_clean
    return f"{root_clean}/{sub_clean}"


def _timestamp_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _normalize_geometry(value: Any) -> Optional[Any]:
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        return value
    return None


def _coords_from_geometry(value: Any) -> Tuple[Optional[float], Optional[float]]:
    if value is None:
        return None, None
    if isinstance(value, dict):
        coords = value.get("coordinates")
        if isinstance(coords, (list, tuple)) and len(coords) >= 2:
            lon, lat = coords[0], coords[1]
            if isinstance(lon, (int, float)) and isinstance(lat, (int, float)):
                return float(lat), float(lon)
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
        return float(y), float(x)
    return None, None


def _iter_stations(page_size: int) -> Iterable[Dict[str, Any]]:
    supabase_url = os.getenv("SUPABASE_URL", "").strip()
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not supabase_url or not service_role_key:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")

    client = create_client(supabase_url, service_role_key)
    offset = 0
    while True:
        resp = (
            client.table("stations")
            .select(
                "id,station_ref,label,station_name,station_type,station_exposure,region,"
                "la_code,la_version,pcon_code,pcon_version,service_ref,connector_id,geometry,"
                "connector:connectors(connector_code)"
            )
            .range(offset, offset + page_size - 1)
            .execute()
        )
        rows = resp.data if hasattr(resp, "data") else resp.get("data")
        if not rows:
            break
        for row in rows:
            yield row
        if len(rows) < page_size:
            break
        offset += page_size


def main() -> int:
    args = parse_args()
    timestamp = _timestamp_utc()
    output_path = Path(args.output) if args.output else Path(f"uk_aq_stations_{timestamp}.json")
    root = _dropbox_root_folder()
    if not root:
        raise RuntimeError("UK_AIR_DROPBOX_ROOT must be set for stations export.")
    dropbox_dir = _join_dropbox_paths(root, args.dropbox_dir or "uk_aq_stations")
    dropbox_path = f"{dropbox_dir}/{output_path.name}"

    stations: List[Dict[str, Any]] = []
    for row in _iter_stations(args.page_size):
        geometry = _normalize_geometry(row.get("geometry"))
        lat, lon = _coords_from_geometry(geometry)
        coordinates = None
        if lat is not None and lon is not None:
            coordinates = f"{lat:.6f} {lon:.6f}"
        connector = row.get("connector") or {}
        stations.append(
            {
                "id": row.get("id"),
                "station_ref": row.get("station_ref"),
                "label": row.get("label"),
                "station_name": row.get("station_name"),
                "station_type": row.get("station_type"),
                "station_exposure": row.get("station_exposure"),
                "coordinates": coordinates,
                "region": row.get("region"),
                "la_code": row.get("la_code"),
                "la_version": row.get("la_version"),
                "pcon_code": row.get("pcon_code"),
                "pcon_version": row.get("pcon_version"),
                "geometry": geometry,
                "service_ref": row.get("service_ref"),
                "connector_id": row.get("connector_id"),
                "connector_code": connector.get("connector_code"),
            }
        )

    payload = {
        "source": "supabase",
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "count": len(stations),
        "stations": stations,
    }

    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    access_token = _dropbox_refresh_access_token()
    _dropbox_upload_file(access_token, output_path, dropbox_path)
    print(f"Dropbox root: {root}")
    print(f"Uploaded {output_path.name} to Dropbox: {dropbox_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
