#!/usr/bin/env python3
"""
Run a local HTTP dashboard for UK AQ freshness buckets (PM2.5 + PM10).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import threading
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

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
DISPATCH_HISTORY_WINDOW_MINUTES = max(
    30,
    int(os.getenv("DISPATCH_HISTORY_WINDOW_MINUTES", "240")),
)
DISPATCH_FETCH_LIMIT = max(
    100,
    int(os.getenv("DISPATCH_FETCH_LIMIT", "1000")),
)
DISPATCH_INCREMENTAL_OVERLAP_SECONDS = max(
    30,
    int(os.getenv("DISPATCH_INCREMENTAL_OVERLAP_SECONDS", "120")),
)
DISPATCH_MAX_ROWS = max(
    200,
    int(os.getenv("DISPATCH_MAX_ROWS", "5000")),
)
IN_FLIGHT_WARN_MINUTES = 5
IN_FLIGHT_MAX_AGE_MINUTES = 180
SCHEDULER_BACKEND_SUPABASE_FUNCTION = "supabase_function"
SCHEDULER_BACKEND_GOOGLE_CLOUD_RUN = "google_cloud_run"
SCHEDULER_BACKEND_ALLOWED = {
    SCHEDULER_BACKEND_SUPABASE_FUNCTION,
    SCHEDULER_BACKEND_GOOGLE_CLOUD_RUN,
}
SCHEDULER_BACKEND_CONNECTOR_ALLOWLIST = {
    "uk_air_sos",
    "sensorcommunity",
    "breathelondon",
    "openaq"
}

CACHE_LOCK = threading.Lock()
CACHE_STATE: Dict[str, Any] = {"data": None, "generated_at": None}
DISPATCH_RUNS_STATE: Dict[str, Any] = {
    "rows": [],
    "latest_created_at": None,
}
CACHE_TTL_SECONDS = 20
UTC_DATETIME_MIN = datetime.min.replace(tzinfo=timezone.utc)


def _normalize_token(value: str) -> str:
    return NON_ALNUM_RE.sub("", value.lower())


NORMALIZED_POLLUTANT_TOKENS = {
    pollutant_key: tuple(_normalize_token(token) for token in config["tokens"])
    for pollutant_key, config in POLLUTANTS.items()
}


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


def _postgrest_headers(service_role_key: str, write: bool = False) -> Dict[str, str]:
    core_schema = os.getenv("UK_AQ_CORE_SCHEMA", "uk_aq_core")
    headers = {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
        "Accept-Profile": core_schema,
    }
    if write:
        headers["Content-Profile"] = core_schema
    return headers


def _base64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _jwt_role(token: str) -> Optional[str]:
    parts = token.split(".")
    if len(parts) != 3:
        return None
    try:
        payload = json.loads(_base64url_decode(parts[1]).decode("utf-8"))
    except (ValueError, json.JSONDecodeError):
        return None
    role = payload.get("role")
    return role if isinstance(role, str) else None


def _project_ref_from_base_url(base_url: str) -> Optional[str]:
    parsed = urlparse(base_url)
    host = parsed.netloc or parsed.path
    host = host.split("/")[0]
    if not host:
        return None
    if host.endswith(".supabase.co"):
        return host.split(".")[0]
    return host


def _request_path(url: str) -> str:
    parsed = urlparse(url)
    return parsed.path or url


def _ensure_allowed_base_url(base_url: str) -> str:
    parsed = urlparse(base_url)
    if parsed.scheme not in {"https", "http"}:
        raise ValueError(f"Unsupported URL scheme for base URL: {parsed.scheme}")
    host = (parsed.hostname or "").lower()
    if not host:
        raise ValueError("Missing hostname in base URL.")
    if host in {"localhost", "127.0.0.1"}:
        return base_url.rstrip("/")
    if host.endswith(".supabase.co") or host.endswith(".supabase.in"):
        return base_url.rstrip("/")
    raise ValueError(f"Unsupported host for base URL: {host}")


def _safe_response_text(resp: requests.Response, max_chars: int = 500) -> str:
    text = (resp.text or "").strip()
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "...(truncated)"


def _fetch_json(url: str, headers: Dict[str, str], params: Dict[str, str]) -> List[Dict[str, Any]]:
    resp = requests.get(url, headers=headers, params=params, timeout=60)
    if not resp.ok:
        params_keys = sorted(params.keys())
        raise RuntimeError(
            (
                "PostgREST GET error "
                f"{resp.status_code} at {_request_path(url)} "
                f"(params_keys={params_keys}): {_safe_response_text(resp)}"
            )
        )
    payload = resp.json()
    return payload if isinstance(payload, list) else []


def _patch_json(
    base_url: str,
    table: str,
    headers: Dict[str, str],
    params: Dict[str, str],
    payload: Dict[str, Any],
) -> None:
    if not re.fullmatch(r"[a-z_]+", table):
        raise ValueError(f"Invalid table name: {table}")
    safe_base_url = _ensure_allowed_base_url(base_url)
    url = f"{safe_base_url}/{table}"
    resp = requests.patch(url, headers=headers, params=params, json=payload, timeout=60)
    if not resp.ok:
        payload_keys = sorted(payload.keys())
        params_keys = sorted(params.keys())
        raise RuntimeError(
            (
                "PostgREST PATCH error "
                f"{resp.status_code} at {_request_path(url)} "
                f"(params_keys={params_keys}, payload_keys={payload_keys}): {_safe_response_text(resp)}"
            )
        )


def _timestamp_or_min(value: Optional[datetime]) -> datetime:
    return value if value is not None else UTC_DATETIME_MIN


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
    *,
    created_since: Optional[datetime] = None,
    limit: int = DISPATCH_FETCH_LIMIT,
) -> List[Dict[str, Any]]:
    params: Dict[str, str] = {
        "select": "id,connector_id,connector_code,run_started_at,run_ended_at,run_status,run_message,last_observed_at,stations_updated,observations_upserted,timeseries_updated,series_polled,response_payload,created_at",
        "order": "created_at.desc.nullslast",
        "limit": str(limit),
    }
    if created_since:
        params["created_at"] = f"gte.{_to_postgrest_ts(created_since)}"
    return _fetch_json(
        f"{base_url}/uk_aq_ingest_runs",
        headers,
        params,
    )


def _fetch_dispatcher_settings(
    base_url: str,
    headers: Dict[str, str],
) -> Dict[str, Any]:
    rows = _fetch_json(
        f"{base_url}/dispatcher_settings",
        headers,
        {
            "select": "id,dispatcher_parallel_ingest,max_runs_per_dispatch_call,updated_at",
            "id": "eq.1",
            "limit": "1",
        },
    )
    if not rows:
        return {
            "id": 1,
            "dispatcher_parallel_ingest": False,
            "max_runs_per_dispatch_call": 1,
            "updated_at": None,
        }
    row = rows[0]
    return {
        "id": row.get("id", 1),
        "dispatcher_parallel_ingest": bool(row.get("dispatcher_parallel_ingest")),
        "max_runs_per_dispatch_call": row.get("max_runs_per_dispatch_call") or 1,
        "updated_at": row.get("updated_at"),
    }


def _parse_timestamp(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    if re.search(r"[+-]\d{2}$", text):
        text = text + ":00"
    if re.search(r"[+-]\d{4}$", text):
        text = text[:-2] + ":" + text[-2:]
    fraction = re.search(r"\.(\d+)", text)
    if fraction:
        digits = fraction.group(1)
        if len(digits) > 6:
            digits = digits[:6]
        else:
            digits = digits.ljust(6, "0")
        text = text[: fraction.start(1)] + digits + text[fraction.end(1) :]
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        if " " in text:
            try:
                return datetime.fromisoformat(text.replace(" ", "T", 1))
            except ValueError:
                return None
        return None


def _to_postgrest_ts(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00",
        "Z",
    )


def _dispatch_run_timestamp(row: Dict[str, Any]) -> Optional[datetime]:
    return _parse_timestamp(
        (row.get("run_ended_at") if isinstance(row, dict) else None)
        or (row.get("run_started_at") if isinstance(row, dict) else None)
    )


def _dispatch_created_timestamp(row: Dict[str, Any]) -> Optional[datetime]:
    return _parse_timestamp(row.get("created_at") if isinstance(row, dict) else None)


def _dispatch_row_key(row: Dict[str, Any]) -> str:
    row_id = row.get("id")
    if row_id is not None:
        return f"id:{row_id}"
    return (
        "fallback:"
        f"{row.get('connector_id')}|{row.get('run_started_at')}|"
        f"{row.get('run_ended_at')}|{row.get('run_status')}"
    )


def _merge_dispatch_runs(
    existing: List[Dict[str, Any]],
    incoming: List[Dict[str, Any]],
    *,
    window_start: datetime,
) -> List[Dict[str, Any]]:
    by_key: Dict[str, Dict[str, Any]] = {}
    for row in [*existing, *incoming]:
        key = _dispatch_row_key(row)
        current = by_key.get(key)
        if current is None:
            by_key[key] = row
            continue
        current_created = _dispatch_created_timestamp(current)
        row_created = _dispatch_created_timestamp(row)
        if _timestamp_or_min(row_created) >= _timestamp_or_min(current_created):
            by_key[key] = row

    merged = list(by_key.values())
    filtered = []
    for row in merged:
        run_ts = _dispatch_run_timestamp(row)
        created_ts = _dispatch_created_timestamp(row)
        if (run_ts and run_ts >= window_start) or (
            created_ts and created_ts >= window_start
        ):
            filtered.append(row)

    filtered.sort(
        key=lambda item: _dispatch_run_timestamp(item)
        or _dispatch_created_timestamp(item)
        or UTC_DATETIME_MIN,
        reverse=True,
    )
    if len(filtered) > DISPATCH_MAX_ROWS:
        return filtered[:DISPATCH_MAX_ROWS]
    return filtered


def _get_ingest_runs_cached(
    base_url: str,
    headers: Dict[str, str],
    now: datetime,
    dispatch_cursor: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    window_start = now - timedelta(minutes=DISPATCH_HISTORY_WINDOW_MINUTES)
    with CACHE_LOCK:
        cached_rows: List[Dict[str, Any]] = list(DISPATCH_RUNS_STATE.get("rows") or [])
        latest_created_at = DISPATCH_RUNS_STATE.get("latest_created_at")

    created_since: Optional[datetime]
    # On cold start (no cached rows), always hydrate the full lookback window.
    # Otherwise a persisted UI cursor from a previous session can cause a partial
    # incremental fetch that misses quieter connectors.
    if not cached_rows:
        created_since = window_start
    elif isinstance(latest_created_at, datetime):
        created_since = latest_created_at - timedelta(
            seconds=DISPATCH_INCREMENTAL_OVERLAP_SECONDS
        )
    elif isinstance(dispatch_cursor, datetime):
        created_since = dispatch_cursor - timedelta(
            seconds=DISPATCH_INCREMENTAL_OVERLAP_SECONDS
        )
    else:
        created_since = window_start
    if created_since < window_start:
        created_since = window_start

    incoming = _fetch_ingest_runs(
        base_url,
        headers,
        created_since=created_since,
    )
    merged = _merge_dispatch_runs(cached_rows, incoming, window_start=window_start)
    newest_created = max(
        (
            _dispatch_created_timestamp(row)
            for row in merged
            if _dispatch_created_timestamp(row) is not None
        ),
        default=latest_created_at if isinstance(latest_created_at, datetime) else None,
    )

    with CACHE_LOCK:
        DISPATCH_RUNS_STATE["rows"] = merged
        DISPATCH_RUNS_STATE["latest_created_at"] = newest_created
    return list(merged)


def _is_truthy_flag(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        candidate = value.strip().lower()
    else:
        candidate = str(value).strip().lower()
    return candidate in {"y", "yes", "true", "1"}


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
        for pollutant_key, tokens in NORMALIZED_POLLUTANT_TOKENS.items():
            for token in tokens:
                if token in cleaned:
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


def _build_dashboard(
    base_url: str,
    service_role_key: str,
    dispatch_cursor: Optional[datetime] = None,
) -> Dict[str, Any]:
    headers = _postgrest_headers(service_role_key)
    project_ref = _project_ref_from_base_url(base_url)

    connectors = _fetch_all(
        base_url,
        headers,
        "connectors",
        {
            "select": "id,connector_code,label,display_name,last_run_start,last_run_end,poll_enabled,poll_interval_minutes,poll_window_hours,poll_timeseries_batch_size,scheduler_backend",
            "order": "connector_code.asc",
        },
    )
    connector_map = {
        row["id"]: {
            "connector_code": row.get("connector_code"),
            "label": row.get("label"),
        }
        for row in connectors
        if row.get("id") is not None
    }

    stations = _fetch_all(
        base_url,
        headers,
        "stations",
        {
            "select": "id,connector_id,service_ref,removed_at",
        },
    )
    station_metadata = _fetch_all(
        base_url,
        headers,
        "station_metadata",
        {
            "select": "station_id,attributes",
        },
    )
    metadata_by_station = {
        row.get("station_id"): row.get("attributes") or {}
        for row in station_metadata
        if row.get("station_id") is not None
    }
    active_station_keys: Dict[Tuple[int, int], bool] = {}
    for row in stations:
        station_id = row.get("id")
        connector_id = row.get("connector_id")
        if station_id is None or connector_id is None:
            continue
        if row.get("removed_at") is not None:
            active_station_keys[(connector_id, station_id)] = False
            continue
        connector_meta = connector_map.get(connector_id, {})
        connector_code = connector_meta.get("connector_code") or ""
        service_ref = row.get("service_ref") or ""
        if connector_code == "breathelondon" and service_ref == "breathelondon":
            attributes = metadata_by_station.get(station_id, {})
            enabled_ok = _is_truthy_flag(attributes.get("enabled"))
            active_ok = _is_truthy_flag(attributes.get("site_active"))
            active_station_keys[(connector_id, station_id)] = enabled_ok or active_ok
        else:
            active_station_keys[(connector_id, station_id)] = True

    now = datetime.now(timezone.utc)
    ingest_runs = _get_ingest_runs_cached(
        base_url,
        headers,
        now,
        dispatch_cursor=dispatch_cursor,
    )
    dispatcher_settings = _fetch_dispatcher_settings(base_url, headers)
    in_flight_rows: List[Dict[str, Any]] = []
    latest_run_by_connector: Dict[int, Dict[str, Any]] = {}
    for row in ingest_runs:
        connector_id = row.get("connector_id")
        if connector_id is None:
            continue
        timestamp = _parse_timestamp(row.get("run_ended_at") or row.get("run_started_at"))
        if not timestamp:
            continue
        current = latest_run_by_connector.get(connector_id)
        if current is None:
            latest_run_by_connector[connector_id] = row
            continue
        current_ts = _parse_timestamp(current.get("run_ended_at") or current.get("run_started_at"))
        if not current_ts or timestamp > current_ts:
            latest_run_by_connector[connector_id] = row

    for connector in connectors:
        connector_id = connector.get("id")
        if connector_id is None:
            continue
        latest_run = latest_run_by_connector.get(connector_id)
        if latest_run:
            last_run_start = _parse_timestamp(latest_run.get("run_started_at"))
            last_run_end = _parse_timestamp(latest_run.get("run_ended_at"))
            if last_run_start and not last_run_end:
                minutes = max(0, int((now - last_run_start).total_seconds() / 60))
                in_flight_rows.append(
                    {
                        "connector_id": connector_id,
                        "connector_code": latest_run.get("connector_code") or connector.get("connector_code"),
                        "connector_label": connector.get("label")
                        or latest_run.get("connector_code")
                        or "",
                        "run_started_at": last_run_start.isoformat().replace("+00:00", "Z"),
                        "run_ended_at": None,
                        "run_status": "running",
                        "run_message": "in_flight",
                        "last_observed_at": None,
                        "stations_updated": None,
                        "observations_upserted": None,
                        "timeseries_updated": None,
                        "series_polled": None,
                        "run_timestamp": last_run_start.isoformat().replace("+00:00", "Z"),
                        "in_flight_minutes": minutes,
                        "in_flight_over_threshold": minutes >= IN_FLIGHT_WARN_MINUTES,
                    }
                )
            continue
        last_run_start = _parse_timestamp(connector.get("last_run_start"))
        last_run_end = _parse_timestamp(connector.get("last_run_end"))
        if last_run_start and not last_run_end:
            minutes = max(0, int((now - last_run_start).total_seconds() / 60))
            if minutes <= IN_FLIGHT_MAX_AGE_MINUTES:
                in_flight_rows.append(
                    {
                        "connector_id": connector_id,
                        "connector_code": connector.get("connector_code"),
                        "connector_label": connector.get("label")
                        or connector.get("connector_code")
                        or "",
                        "run_started_at": last_run_start.isoformat().replace("+00:00", "Z"),
                        "run_ended_at": None,
                        "run_status": "running",
                        "run_message": "in_flight",
                        "last_observed_at": None,
                        "stations_updated": None,
                        "observations_upserted": None,
                        "timeseries_updated": None,
                        "series_polled": None,
                        "run_timestamp": last_run_start.isoformat().replace("+00:00", "Z"),
                        "in_flight_minutes": minutes,
                        "in_flight_over_threshold": minutes >= IN_FLIGHT_WARN_MINUTES,
                    }
                )
    for row in ingest_runs:
        connector_id = row.get("connector_id")
        meta = connector_map.get(connector_id, {})
        row["connector_label"] = meta.get("label") or row.get("connector_code") or ""
        row["run_timestamp"] = row.get("run_ended_at") or row.get("run_started_at")
        row.setdefault("in_flight_minutes", None)
        row.setdefault("in_flight_over_threshold", False)

    dispatch_runs = in_flight_rows + ingest_runs
    dispatch_runs.sort(
        key=lambda item: _parse_timestamp(item.get("run_timestamp"))
        or UTC_DATETIME_MIN,
        reverse=True,
    )

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
    active_by_pollutant: Dict[str, Dict[Tuple[int, int], bool]] = {
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
        if active_station_keys.get(key):
            active_by_pollutant[pollutant_key][key] = True

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
                "active_stations_with_pollutant": 0,
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
                    "active_stations_with_pollutant": 0,
                    "buckets": {bucket_name: 0 for bucket_name in BUCKETS},
                },
            )
            entry["stations_with_pollutant"] += 1
            entry["buckets"][bucket] += 1
            if active_by_pollutant[pollutant_key].get((connector_id, _station_id)):
                entry["active_stations_with_pollutant"] += 1

        connectors_payload = list(connector_counts.values())
        connectors_payload.sort(key=lambda row: row.get("connector_code") or "")

        pollutants_payload.append(
            {
                "key": pollutant_key,
                "label": config["label"],
                "connectors": connectors_payload,
            },
        )

    next_dispatch_cursor: Optional[str] = None
    with CACHE_LOCK:
        latest_created_at = DISPATCH_RUNS_STATE.get("latest_created_at")
        if isinstance(latest_created_at, datetime):
            next_dispatch_cursor = _to_postgrest_ts(latest_created_at)

    return {
        "project_ref": project_ref,
        "generated_at": now.isoformat().replace("+00:00", "Z"),
        "dispatch_cursor": next_dispatch_cursor,
        "buckets": list(BUCKETS),
        "pollutants": pollutants_payload,
        "dispatch_runs": dispatch_runs,
        "dispatcher_settings": dispatcher_settings,
        "connectors_settings": [
            {
                "id": row.get("id"),
                "connector_code": row.get("connector_code"),
                "label": row.get("label"),
                "display_name": row.get("display_name"),
                "poll_enabled": row.get("poll_enabled"),
                "poll_interval_minutes": row.get("poll_interval_minutes"),
                "poll_window_hours": row.get("poll_window_hours"),
                "poll_timeseries_batch_size": row.get("poll_timeseries_batch_size"),
                "scheduler_backend": row.get("scheduler_backend")
                or SCHEDULER_BACKEND_SUPABASE_FUNCTION,
            }
            for row in connectors
            if row.get("id") is not None
        ],
    }


def _get_dashboard(
    base_url: str,
    service_role_key: str,
    dispatch_cursor: Optional[datetime] = None,
) -> Dict[str, Any]:
    # Cursor-based requests are incremental and should not be served from the shared cache.
    if dispatch_cursor is not None:
        return _build_dashboard(
            base_url,
            service_role_key,
            dispatch_cursor=dispatch_cursor,
        )

    with CACHE_LOCK:
        cached = CACHE_STATE.get("data")
        generated_at = CACHE_STATE.get("generated_at")
        if cached and generated_at:
            age = (datetime.now(timezone.utc) - generated_at).total_seconds()
            if age < CACHE_TTL_SECONDS:
                return cached
    data = _build_dashboard(
        base_url,
        service_role_key,
        dispatch_cursor=dispatch_cursor,
    )
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
            self._serve_dashboard(parsed)
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/connectors":
            self._update_connectors()
            return
        if parsed.path == "/api/dispatcher_settings":
            self._update_dispatcher_settings()
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

    def _serve_dashboard(self, parsed) -> None:
        dispatch_cursor: Optional[datetime] = None
        query = parse_qs(parsed.query, keep_blank_values=False)
        cursor_values = query.get("dispatch_cursor") or []
        if cursor_values:
            parsed_cursor = _parse_timestamp(cursor_values[0])
            if isinstance(parsed_cursor, datetime):
                now = datetime.now(timezone.utc)
                # Reject far-future cursors; clamp old cursors via history window in fetch path.
                if parsed_cursor <= now + timedelta(minutes=5):
                    dispatch_cursor = parsed_cursor
        try:
            data = _get_dashboard(
                self.server.base_url,
                self.server.service_role_key,
                dispatch_cursor=dispatch_cursor,
            )
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

    def _update_connectors(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw_body = self.rfile.read(length) if length > 0 else b""
        try:
            body = json.loads(raw_body.decode("utf-8")) if raw_body else {}
        except json.JSONDecodeError:
            body = {}

        updates = body.get("updates") if isinstance(body, dict) else None
        if not isinstance(updates, list):
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid payload")
            return

        headers = _postgrest_headers(self.server.service_role_key, write=True)
        base_url = self.server.base_url
        try:
            for entry in updates:
                if not isinstance(entry, dict):
                    continue
                connector_id = entry.get("id")
                if connector_id is None:
                    continue
                scheduler_backend = entry.get("scheduler_backend")
                if scheduler_backend is None or scheduler_backend == "":
                    scheduler_backend = SCHEDULER_BACKEND_SUPABASE_FUNCTION
                if scheduler_backend not in SCHEDULER_BACKEND_ALLOWED:
                    self.send_error(
                        HTTPStatus.BAD_REQUEST,
                        f"Invalid scheduler_backend for connector id {connector_id}",
                    )
                    return
                connector_code = str(entry.get("connector_code") or "").strip()
                if (
                    scheduler_backend == SCHEDULER_BACKEND_GOOGLE_CLOUD_RUN
                    and connector_code not in SCHEDULER_BACKEND_CONNECTOR_ALLOWLIST
                ):
                    self.send_error(
                        HTTPStatus.BAD_REQUEST,
                        (
                            "google_cloud_run scheduler_backend is only allowed for "
                            f"{', '.join(sorted(SCHEDULER_BACKEND_CONNECTOR_ALLOWLIST))}"
                        ),
                    )
                    return
                payload = {
                    "poll_enabled": entry.get("poll_enabled"),
                    "poll_interval_minutes": entry.get("poll_interval_minutes"),
                    "poll_window_hours": entry.get("poll_window_hours"),
                    "poll_timeseries_batch_size": entry.get("poll_timeseries_batch_size"),
                    "scheduler_backend": scheduler_backend,
                }
                _patch_json(
                    base_url,
                    "connectors",
                    headers,
                    {"id": f"eq.{connector_id}"},
                    payload,
                )
        except Exception as exc:
            payload = json.dumps({"error": str(exc)}, indent=2)
            self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))
            return

        with CACHE_LOCK:
            CACHE_STATE["data"] = None
            CACHE_STATE["generated_at"] = None

        payload = json.dumps({"status": "ok"}, indent=2)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))

    def _update_dispatcher_settings(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw_body = self.rfile.read(length) if length > 0 else b""
        try:
            body = json.loads(raw_body.decode("utf-8")) if raw_body else {}
        except json.JSONDecodeError:
            body = {}

        if not isinstance(body, dict):
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid payload")
            return

        parallel = body.get("dispatcher_parallel_ingest")
        max_runs = body.get("max_runs_per_dispatch_call")
        if max_runs is not None:
            try:
                max_runs = int(max_runs)
            except (TypeError, ValueError):
                self.send_error(HTTPStatus.BAD_REQUEST, "Invalid max_runs_per_dispatch_call")
                return
            if max_runs < 1:
                self.send_error(HTTPStatus.BAD_REQUEST, "max_runs_per_dispatch_call must be >= 1")
                return

        headers = _postgrest_headers(self.server.service_role_key, write=True)
        base_url = self.server.base_url
        payload = {
            "dispatcher_parallel_ingest": bool(parallel),
            "max_runs_per_dispatch_call": max_runs or 1,
            "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        try:
            _patch_json(
                base_url,
                "dispatcher_settings",
                headers,
                {"id": "eq.1"},
                payload,
            )
        except Exception as exc:
            payload = json.dumps({"error": str(exc)}, indent=2)
            self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))
            return

        with CACHE_LOCK:
            CACHE_STATE["data"] = None
            CACHE_STATE["generated_at"] = None

        payload = json.dumps({"status": "ok"}, indent=2)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))


def parse_args() -> argparse.Namespace:
    host_default = os.getenv("HOST", "127.0.0.1")
    try:
        port_default = int(os.getenv("PORT", "8045"))
    except ValueError:
        port_default = 8045
    parser = argparse.ArgumentParser(description="Run a local UK AQ dashboard API.")
    parser.add_argument("--host", default=host_default, help="Bind host (default: HOST or 127.0.0.1).")
    parser.add_argument("--port", type=int, default=port_default, help="Bind port (default: PORT or 8045).")
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
        default=os.getenv("SB_SECRET_KEY"),
        help="Supabase service role key (default: SB_SECRET_KEY).",
    )
    return parser.parse_args()


def main() -> None:
    _load_env(Path(".env"))
    args = parse_args()

    supabase_url = (args.supabase_url or "").strip().rstrip("/")
    service_role_key = (args.service_role_key or "").strip()
    if not supabase_url or not service_role_key:
        raise SystemExit("SUPABASE_URL and SB_SECRET_KEY are required.")
    role = _jwt_role(service_role_key)
    if role and role != "service_role":
        raise SystemExit(
            "SB_SECRET_KEY must be a service role key; "
            f"current token role is '{role}'."
        )

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
