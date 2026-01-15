#!/usr/bin/env python3
"""
Export all stations from Supabase and upload a timestamped JSON file to Dropbox.
"""

from __future__ import annotations

import argparse
import json
import os
import re
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


def _timestamp_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _parse_point_geometry(value: Any) -> Tuple[Optional[float], Optional[float]]:
    if value is None:
        return None, None
    if isinstance(value, dict):
        coords = value.get("coordinates")
        if isinstance(coords, (list, tuple)) and len(coords) >= 2:
            return float(coords[0]), float(coords[1])
    if isinstance(value, str):
        match = re.search(r"POINT\(([-0-9.]+)\s+([-0-9.]+)\)", value)
        if match:
            return float(match.group(1)), float(match.group(2))
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
    dropbox_dir = _normalize_dropbox_path(args.dropbox_dir) or "/uk_aq_stations"
    dropbox_path = f"{dropbox_dir}/{output_path.name}"

    stations: List[Dict[str, Any]] = []
    for row in _iter_stations(args.page_size):
        lon, lat = _parse_point_geometry(row.get("geometry"))
        connector = row.get("connector") or {}
        stations.append(
            {
                "station_ref": row.get("station_ref"),
                "label": row.get("label"),
                "station_name": row.get("station_name"),
                "station_type": row.get("station_type"),
                "station_exposure": row.get("station_exposure"),
                "region": row.get("region"),
                "la_code": row.get("la_code"),
                "la_version": row.get("la_version"),
                "pcon_code": row.get("pcon_code"),
                "pcon_version": row.get("pcon_version"),
                "longitude": lon,
                "latitude": lat,
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
    print(f"Uploaded {output_path.name} to Dropbox: {dropbox_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
