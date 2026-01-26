#!/usr/bin/env python3
"""
Run a local HTTP dashboard for UK AQ freshness buckets (PM2.5 + PM10).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import threading
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlparse

import requests

NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
POLLUTANTS = {
    "pm25": {"label": "PM2.5", "tokens": ("pm25", "pm2.5", "pm2-5", "pm2_5")},
    "pm10": {"label": "PM10", "tokens": ("pm10",)},
    "no2": {"label": "NO2", "tokens": ("no2",)},
}
BUCKETS = ("0-3 Hours", "3-6 Hours", "6-24 Hours", "1 - 7 Days", "Older than 7 Days")
EXCLUDED_CONNECTORS_BY_POLLUTANT = {
    "pm10": {"breathelondon"},
    "no2": {"sensorcommunity"},
}
DISPATCH_FEED_LIMIT = 30

CACHE_LOCK = threading.Lock()
CACHE_STATE: Dict[str, Any] = {"data": None, "generated_at": None}
CACHE_TTL_SECONDS = 20


def _load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _postgrest_headers(service_role_key: str) -> Dict[str, str]:
    return {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
    }


def _fetch_json(url: str, headers: Dict[str, str], params: Dict[str, str]) -> List[Dict[str, Any]]:
    resp = requests.get(url, headers=headers, params=params, timeout=60)
    if not resp.ok:
        raise RuntimeError(f"PostgREST error {resp.status_code}: {resp.text}")
    payload = resp.json()
    return payload if isinstance(payload, list) else []


def _fetch_all(
    base_url: str,
    headers: Dict[str, str],
    table: str,
    params: Dict[str, str],
    limit: int = 1000,
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    offset = 0
    while True:
        batch_params = dict(params)
        batch_params["limit"] = str(limit)
        batch_params["offset"] = str(offset)
        batch = _fetch_json(f"{base_url}/{table}", headers, batch_params)
        rows.extend(batch)
        if len(batch) < limit:
            break
        offset += limit
    return rows


def _fetch_ingest_runs(
    base_url: str,
    headers: Dict[str, str],
    limit: int = DISPATCH_FEED_LIMIT,
) -> List[Dict[str, Any]]:
    return _fetch_json(
        f"{base_url}/uk_aq_ingest_runs",
        headers,
        {
            "select": "connector_id,connector_code,run_started_at,run_ended_at,run_status,run_message,stations_updated,observations_upserted,timeseries_updated,series_polled",
            "order": "run_ended_at.desc.nullslast",
            "limit": str(limit),
        },
    )


def _parse_timestamp(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _normalize_token(value: str) -> str:
    return NON_ALNUM_RE.sub("", value.lower())


def _extract_pollutant_key(row: Dict[str, Any]) -> Optional[str]:
    candidates: List[str] = []
    phenomenon = row.get("phenomenon") or {}
    for key in ("notation", "pollutant_label", "label"):
        value = phenomenon.get(key)
        if value:
            candidates.append(str(value))
    if row.get("label"):
        candidates.append(str(row["label"]))

    for candidate in candidates:
        cleaned = _normalize_token(candidate)
        for pollutant_key, config in POLLUTANTS.items():
            for token in config["tokens"]:
                if _normalize_token(token) in cleaned:
                    return pollutant_key
    return None


def _bucket_for(latest_at: datetime, now: datetime) -> str:
    if latest_at >= now - timedelta(hours=3):
        return "0-3 Hours"
    if latest_at >= now - timedelta(hours=6):
        return "3-6 Hours"
    if latest_at >= now - timedelta(hours=24):
        return "6-24 Hours"
    if latest_at >= now - timedelta(days=7):
        return "1 - 7 Days"
    return "Older than 7 Days"


def _build_dashboard(base_url: str, service_role_key: str) -> Dict[str, Any]:
    headers = _postgrest_headers(service_role_key)

    connectors = _fetch_all(
        base_url,
        headers,
        "connectors",
        {"select": "id,connector_code,label", "order": "connector_code.asc"},
    )
    connector_map = {
        row["id"]: {
            "connector_code": row.get("connector_code"),
            "label": row.get("label"),
        }
        for row in connectors
        if row.get("id") is not None
    }
    ingest_runs = _fetch_ingest_runs(base_url, headers)
    for row in ingest_runs:
        connector_id = row.get("connector_id")
        meta = connector_map.get(connector_id, {})
        row["connector_label"] = meta.get("label") or row.get("connector_code") or ""
        row["run_timestamp"] = row.get("run_ended_at") or row.get("run_started_at")

    timeseries_rows = _fetch_all(
        base_url,
        headers,
        "timeseries",
        {
            "select": "station_id,connector_id,last_value,last_value_at,label,phenomenon:phenomena(label,notation,pollutant_label)",
            "last_value_at": "not.is.null",
            "last_value": "not.is.null",
        },
    )

    latest_by_pollutant: Dict[str, Dict[Tuple[int, int], datetime]] = {
        pollutant_key: {}
        for pollutant_key in POLLUTANTS.keys()
    }

    for row in timeseries_rows:
        station_id = row.get("station_id")
        connector_id = row.get("connector_id")
        if station_id is None or connector_id is None:
            continue
        latest_at = _parse_timestamp(row.get("last_value_at"))
        if not latest_at:
            continue
        pollutant_key = _extract_pollutant_key(row)
        if pollutant_key not in latest_by_pollutant:
            continue
        key = (connector_id, station_id)
        current = latest_by_pollutant[pollutant_key].get(key)
        if current is None or latest_at > current:
            latest_by_pollutant[pollutant_key][key] = latest_at

    now = datetime.now(timezone.utc)
    pollutants_payload: List[Dict[str, Any]] = []

    for pollutant_key, config in POLLUTANTS.items():
        connector_counts: Dict[int, Dict[str, Any]] = {}
        excluded_connectors = EXCLUDED_CONNECTORS_BY_POLLUTANT.get(pollutant_key, set())
        for connector_id, meta in connector_map.items():
            connector_code = meta.get("connector_code") or ""
            if connector_code in excluded_connectors:
                continue
            connector_counts[connector_id] = {
                "connector_code": meta.get("connector_code") or "",
                "label": meta.get("label") or "",
                "stations_with_pollutant": 0,
                "buckets": {bucket: 0 for bucket in BUCKETS},
            }

        for (connector_id, _station_id), latest_at in latest_by_pollutant[pollutant_key].items():
            meta = connector_map.get(connector_id, {})
            connector_code = meta.get("connector_code") or ""
            if connector_code in excluded_connectors:
                continue
            bucket = _bucket_for(latest_at, now)
            entry = connector_counts.setdefault(
                connector_id,
                {
                    "connector_code": "",
                    "label": "",
                    "stations_with_pollutant": 0,
                    "buckets": {bucket_name: 0 for bucket_name in BUCKETS},
                },
            )
            entry["stations_with_pollutant"] += 1
            entry["buckets"][bucket] += 1

        connectors_payload = list(connector_counts.values())
        connectors_payload.sort(key=lambda row: row.get("connector_code") or "")

        pollutants_payload.append(
            {
                "key": pollutant_key,
                "label": config["label"],
                "connectors": connectors_payload,
            },
        )

    return {
        "generated_at": now.isoformat().replace("+00:00", "Z"),
        "buckets": list(BUCKETS),
        "pollutants": pollutants_payload,
        "dispatch_runs": ingest_runs,
    }


def _get_dashboard(base_url: str, service_role_key: str) -> Dict[str, Any]:
    with CACHE_LOCK:
        cached = CACHE_STATE.get("data")
        generated_at = CACHE_STATE.get("generated_at")
        if cached and generated_at:
            age = (datetime.now(timezone.utc) - generated_at).total_seconds()
            if age < CACHE_TTL_SECONDS:
                return cached
    data = _build_dashboard(base_url, service_role_key)
    with CACHE_LOCK:
        CACHE_STATE["data"] = data
        CACHE_STATE["generated_at"] = datetime.now(timezone.utc)
    return data


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "uk-aq-dashboard/1.0"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            self._serve_html()
            return
        if parsed.path == "/api/dashboard":
            self._serve_dashboard()
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _serve_html(self) -> None:
        html_path: Path = self.server.html_path
        try:
            content = html_path.read_text(encoding="utf-8")
        except OSError as exc:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content.encode("utf-8"))

    def _serve_dashboard(self) -> None:
        try:
            data = _get_dashboard(self.server.base_url, self.server.service_role_key)
        except Exception as exc:
            payload = json.dumps({"error": str(exc)}, indent=2)
            self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))
            return

        payload = json.dumps(data, indent=2)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a local UK AQ dashboard API.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1).")
    parser.add_argument("--port", type=int, default=8045, help="Bind port (default: 8045).")
    parser.add_argument(
        "--html",
        default="data/uk_aq_dashboard/uk_aq_dashboard.html",
        help="Path to HTML file.",
    )
    parser.add_argument(
        "--supabase-url",
        default=os.getenv("SUPABASE_URL"),
        help="Supabase URL (default: SUPABASE_URL).",
    )
    parser.add_argument(
        "--service-role-key",
        default=os.getenv("SUPABASE_SERVICE_ROLE_KEY"),
        help="Supabase service role key (default: SUPABASE_SERVICE_ROLE_KEY).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    _load_env(Path(".env"))

    supabase_url = (args.supabase_url or "").strip().rstrip("/")
    service_role_key = (args.service_role_key or "").strip()
    if not supabase_url or not service_role_key:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")

    html_path = Path(args.html)
    if not html_path.exists():
        raise SystemExit(f"HTML file not found: {html_path}")

    base_url = f"{supabase_url}/rest/v1"
    server = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    server.base_url = base_url
    server.service_role_key = service_role_key
    server.html_path = html_path

    print(f"UK AQ dashboard running at http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
