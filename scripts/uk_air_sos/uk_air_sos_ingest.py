#!/usr/bin/env python3
"""
UK-AIR SOS ingestion helper.

This script:
1) Discovers SOS metadata (services, stations, timeseries) for a filtered set of stations.
2) Backfills observations for a chosen year.
3) Supports incremental refreshes for the last N hours (default 6h).

Environment:
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- UK_AIR_SOS_BASE_URL (optional; defaults to https://uk-air.defra.gov.uk/sos-ukair/api/v1)
- UK_AIR_SOS_SERVICE_LABEL (optional; defaults to UK-AIR-SOS)
- connectors.poll_timeseries_batch_size (optional; overrides default batch size)
- connectors.stations_bbox_supported (optional; when false, skip bbox for station discovery)
- connectors.timeseries_station_filter_supported (optional; when false, skip station filtering for timeseries)

Examples:
  python3 scripts/uk_air_sos/uk_air_sos_ingest.py --discover --backfill-2025
  python3 scripts/uk_air_sos/uk_air_sos_ingest.py --refresh-recent --hours 6
"""

import argparse
import gzip
import html
import json
import logging
import os
import re
import tempfile
import time
import traceback
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

import requests
from dotenv import load_dotenv
from supabase import Client, create_client

from scripts.ingest_helpers import station_coords, station_in_bbox, station_in_bbox_or_missing_coords
load_dotenv()

DEFAULT_LOG_LEVEL = os.getenv("UK_AIR_LOG_LEVEL", "WARNING").upper()
DEFAULT_FILE_LOG_LEVEL = os.getenv("UK_AIR_FILE_LOG_LEVEL", "INFO").upper()
PROGRESS_DOT_EVERY = 50
LOG = logging.getLogger("uk_air_sos")
logging.basicConfig(
    level=getattr(logging, DEFAULT_LOG_LEVEL, logging.WARNING),
    format="%(asctime)s %(levelname)s %(message)s",
)

UK_AIR_SOS_BASE_URL = (
    os.getenv("UK_AIR_SOS_BASE_URL")
    or os.getenv("UK_AIR_BASE_URL")
    or os.getenv("UKAIR_BASE_URL")
    or "https://uk-air.defra.gov.uk/sos-ukair/api/v1"
).rstrip("/")
UK_AIR_SOS_SERVICE_LABEL = (
    os.getenv("UK_AIR_SOS_SERVICE_LABEL")
    or os.getenv("UK_AIR_SERVICE_LABEL")
    or "UK-AIR-SOS"
)
UK_AIR_SOS_CONNECTOR_CODE = "uk_air_sos"

UK_BBOX = {
    "west": -11.0,
    "south": 49.0,
    "east": 2.0,
    "north": 61.0,
}
DEFAULT_POLLUTANTS = {"no2", "o3", "pm10", "pm2.5"}
EIONET_POLLUTANT_RE = re.compile(r"https?://dd\.eionet\.europa\.eu/vocabulary/aq/pollutant/\d+")
DEFAULT_TIMESERIES_STATION_BATCH_SIZE = 50
DEFAULT_RAW_DROPBOX_FOLDER = "/raw_data"
DEFAULT_ERROR_DROPBOX_FOLDER = "/error_log"
DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token"
DROPBOX_UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload"
DROPBOX_LIST_FOLDER_URL = "https://api.dropboxapi.com/2/files/list_folder"
DROPBOX_DOWNLOAD_ZIP_URL = "https://content.dropboxapi.com/2/files/download_zip"
DROPBOX_DELETE_URL = "https://api.dropboxapi.com/2/files/delete_v2"


@dataclass(frozen=True)
class ConnectorContext:
    id: int
    service_ref: str
    label: str
    service_url: str


@dataclass(frozen=True)
class DropboxConfig:
    app_key: str
    app_secret: str
    refresh_token: str
    folder: str


class RawPayloadRecorder:
    def __init__(self, output_path: Path) -> None:
        self.output_path = output_path
        self._handle = gzip.open(output_path, "wt", encoding="utf-8")
        self.count = 0
        self.record_event("meta", {"created_at": utcnow().isoformat()})

    def record_event(self, name: str, payload: Dict[str, Any]) -> None:
        self._write(
            {
                "type": name,
                "recorded_at": utcnow().isoformat(),
                "payload": payload,
            }
        )

    def record_response(
        self,
        path: str,
        params: Optional[Dict[str, Any]],
        status_code: int,
        payload: Any,
    ) -> None:
        self._write(
            {
                "type": "response",
                "fetched_at": utcnow().isoformat(),
                "path": path,
                "params": params,
                "status_code": status_code,
                "payload": payload,
            }
        )

    def _write(self, payload: Dict[str, Any]) -> None:
        self._handle.write(json.dumps(payload, ensure_ascii=True) + "\n")
        self.count += 1

    def close(self) -> None:
        self._handle.close()


@dataclass
class RawDropboxSession:
    recorder: RawPayloadRecorder
    config: DropboxConfig
    temp_dir: tempfile.TemporaryDirectory
    log_path: Path
    log_handler: logging.Handler

    def finalize(self) -> None:
        logging.getLogger().removeHandler(self.log_handler)
        self.log_handler.close()
        self.recorder.close()
        try:
            access_token = _dropbox_refresh_access_token(self.config)
            if self.recorder.count > 1:
                dropbox_path = _dropbox_target_path(self.config.folder, self.recorder.output_path.name)
                _dropbox_upload_file(access_token, self.recorder.output_path, dropbox_path)
                _emit_info(f"Uploaded raw payloads to Dropbox: {dropbox_path}")
            else:
                LOG.debug("Raw payload capture produced no response entries; skipping raw Dropbox upload.")
            log_dropbox_path = _dropbox_log_target_path(self.config.folder, self.log_path.name)
            _dropbox_upload_file(access_token, self.log_path, log_dropbox_path)
            _dropbox_archive_logs(access_token, _dropbox_log_root_folder(self.config.folder), days=31)
        except Exception as exc:
            LOG.warning("Dropbox upload failed: %s", exc)
        finally:
            self.temp_dir.cleanup()


class ErrorLogger:
    def __init__(self, client: Client) -> None:
        self.client = client
        self.dropbox_config = _load_error_dropbox_config()
        self._dropbox_access_token: Optional[str] = None

    def log_error(
        self,
        *,
        source: str,
        severity: str,
        message: str,
        context: Optional[Dict[str, Any]] = None,
        connector_id: Optional[int] = None,
        station_id: Optional[int] = None,
        timeseries_id: Optional[int] = None,
        exc: Optional[BaseException] = None,
    ) -> None:
        error_id = str(uuid.uuid4())
        created_at = utcnow().isoformat()
        stack = None
        if exc is not None:
            stack = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        payload: Dict[str, Any] = {
            "id": error_id,
            "source": source,
            "severity": severity,
            "message": message,
            "stack": stack,
            "context": context,
            "connector_id": connector_id,
            "station_id": station_id,
            "timeseries_id": timeseries_id,
        }
        try:
            self.client.table("error_logs").insert(payload).execute()
        except Exception as insert_exc:
            LOG.warning("Failed to insert error_logs row: %s", insert_exc)
            return

        if not self.dropbox_config:
            return

        dropbox_path = _dropbox_error_target_path(
            self.dropbox_config.folder,
            _build_error_filename(created_at, error_id),
        )
        error_payload = {
            "id": error_id,
            "created_at": created_at,
            "source": source,
            "severity": severity,
            "message": message,
            "stack": stack,
            "context": context,
            "connector_id": connector_id,
            "station_id": station_id,
            "timeseries_id": timeseries_id,
        }
        try:
            if not self._dropbox_access_token:
                self._dropbox_access_token = _dropbox_refresh_access_token(self.dropbox_config)
            _dropbox_upload_bytes(
                self._dropbox_access_token,
                json.dumps(error_payload, ensure_ascii=True, indent=2).encode("utf-8"),
                dropbox_path,
            )
            self.client.table("error_logs").update({"dropbox_path": dropbox_path}).eq(
                "id",
                error_id,
            ).execute()
        except Exception as exc:
            LOG.warning("Dropbox error log upload failed: %s", exc)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _configure_logging(console_level_name: str, file_level_name: str) -> None:
    console_level = getattr(logging, (console_level_name or "").upper(), logging.WARNING)
    file_level = getattr(logging, (file_level_name or "").upper(), logging.INFO)
    logging.getLogger().setLevel(min(console_level, file_level))
    LOG.setLevel(min(console_level, file_level))
    for handler in logging.getLogger().handlers:
        handler.setLevel(console_level)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("supabase").setLevel(logging.WARNING)
    logging.getLogger("postgrest").setLevel(logging.WARNING)
    logging.getLogger("gotrue").setLevel(logging.WARNING)


def _emit_info(message: str) -> None:
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S,%f")[:-3]
    print(f"{timestamp} INFO {message}")


def _progress_start(label: str, total: int) -> None:
    if total <= 0:
        print(f"{label}: none.")
        return
    print(f"{label}: {total} items", end="", flush=True)


def _progress_tick(current: int, total: int) -> None:
    if total <= 0:
        return
    if current % PROGRESS_DOT_EVERY == 0 or current == total:
        print(".", end="", flush=True)


def _progress_done(label: str, total: int) -> None:
    if total <= 0:
        return
    print("")
    print(f"{label} complete.")


def _add_file_logger(path: Path, level_name: str) -> logging.Handler:
    level = getattr(logging, (level_name or "").upper(), logging.INFO)
    handler = logging.FileHandler(path, encoding="utf-8")
    handler.setLevel(level)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logging.getLogger().addHandler(handler)
    return handler


def _dropbox_refresh_access_token(config: DropboxConfig) -> str:
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": config.refresh_token,
        "client_id": config.app_key,
        "client_secret": config.app_secret,
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

def _dropbox_upload_bytes(access_token: str, payload: bytes, dropbox_path: str) -> None:
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
    resp = requests.post(DROPBOX_UPLOAD_URL, headers=headers, data=payload, timeout=120)
    if resp.status_code >= 400:
        raise RuntimeError(f"Dropbox upload failed ({resp.status_code}): {resp.text}")


def _dropbox_download_zip(access_token: str, folder_path: str) -> bytes:
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Dropbox-API-Arg": json.dumps({"path": folder_path}),
    }
    resp = requests.post(DROPBOX_DOWNLOAD_ZIP_URL, headers=headers, timeout=120)
    if resp.status_code >= 400:
        raise RuntimeError(f"Dropbox download_zip failed ({resp.status_code}): {resp.text}")
    return resp.content

def _dropbox_base_folder(folder: str) -> str:
    root = _dropbox_root_folder(folder or DEFAULT_RAW_DROPBOX_FOLDER)
    if root:
        return f"{root}/raw_data"
    return "/raw_data"


def _normalize_dropbox_path(path: str) -> str:
    cleaned = (path or "").strip()
    if not cleaned:
        return ""
    if not cleaned.startswith("/"):
        cleaned = f"/{cleaned}"
    return cleaned.rstrip("/")


def _dropbox_root_folder(folder: str) -> str:
    env_root = _normalize_dropbox_path(os.getenv("UK_AIR_DROPBOX_ROOT", ""))
    cleaned = _normalize_dropbox_path(folder)
    if cleaned.endswith("/raw_data"):
        cleaned = cleaned[: -len("/raw_data")]
    elif cleaned.endswith("/log"):
        cleaned = cleaned[: -len("/log")]
    elif cleaned.endswith("/error_log"):
        cleaned = cleaned[: -len("/error_log")]
    if env_root:
        if not cleaned:
            return env_root
        if cleaned == env_root or cleaned.startswith(f"{env_root}/"):
            return cleaned
        return f"{env_root}{cleaned}"
    return cleaned


def _dropbox_target_path(folder: str, filename: str) -> str:
    date_folder = utcnow().strftime("%Y-%m-%d")
    return f"{_dropbox_base_folder(folder)}/{date_folder}/{filename}"


def _dropbox_log_root_folder(folder: str) -> str:
    root = _dropbox_root_folder(folder)
    if root:
        return f"{root}/log"
    return "/log"


def _dropbox_log_folder_path(folder: str, date_folder: Optional[str] = None) -> str:
    root = _dropbox_log_root_folder(folder)
    date_folder = date_folder or utcnow().strftime("%Y-%m-%d")
    return f"{root}/{date_folder}"


def _dropbox_log_target_path(folder: str, filename: str) -> str:
    return f"{_dropbox_log_folder_path(folder)}/{filename}"


def _dropbox_error_root_folder(folder: str) -> str:
    root = _dropbox_root_folder(folder or DEFAULT_ERROR_DROPBOX_FOLDER)
    if root.endswith("/error_log"):
        root = root[: -len("/error_log")]
    if root:
        return f"{root}/error_log"
    return "/error_log"


def _dropbox_error_folder_path(folder: str, date_folder: Optional[str] = None) -> str:
    root = _dropbox_error_root_folder(folder)
    date_folder = date_folder or utcnow().strftime("%Y-%m-%d")
    return f"{root}/{date_folder}"


def _dropbox_error_target_path(folder: str, filename: str) -> str:
    return f"{_dropbox_error_folder_path(folder)}/{filename}"


def _dropbox_archive_logs(
    access_token: str,
    log_root: str,
    days: int = 31,
    archive_days: int = 365,
) -> None:
    headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}
    cutoff_date = (utcnow() - timedelta(days=days)).date()
    archive_cutoff = (utcnow() - timedelta(days=archive_days)).date()
    archive_root = f"{log_root}/archive"

    def list_folder(path: str) -> List[Dict[str, Any]]:
        payload: Dict[str, Any] = {"path": path}
        entries: List[Dict[str, Any]] = []
        while True:
            resp = requests.post(DROPBOX_LIST_FOLDER_URL, headers=headers, json=payload, timeout=30)
            if resp.status_code == 409:
                return []
            if resp.status_code >= 400:
                raise RuntimeError(f"Dropbox list_folder failed ({resp.status_code}): {resp.text}")
            data = resp.json()
            entries.extend(data.get("entries", []))
            if not data.get("has_more"):
                return entries
            payload = {"cursor": data.get("cursor")}

    entries = list_folder(log_root)
    archive_entries = list_folder(archive_root)
    existing_archives = {
        entry.get("name")
        for entry in archive_entries
        if entry.get(".tag") == "file" and entry.get("name")
    }

    for entry in entries:
        if entry.get(".tag") != "folder":
            continue
        name = entry.get("name")
        if not name or name == "archive":
            continue
        try:
            folder_date = datetime.strptime(name, "%Y-%m-%d").date()
        except ValueError:
            continue
        if folder_date >= cutoff_date:
            continue
        archive_name = f"{name}.zip"
        archive_path = f"{archive_root}/{archive_name}"
        folder_path = entry.get("path_lower") or entry.get("path_display")
        if not folder_path:
            continue
        if archive_name not in existing_archives:
            zip_payload = _dropbox_download_zip(access_token, folder_path)
            _dropbox_upload_bytes(access_token, zip_payload, archive_path)
        delete_resp = requests.post(
            DROPBOX_DELETE_URL,
            headers=headers,
            json={"path": folder_path},
            timeout=30,
        )
        if delete_resp.status_code >= 400:
            LOG.warning(
                "Dropbox log folder delete failed (%s): %s",
                delete_resp.status_code,
                delete_resp.text,
            )

    for entry in archive_entries:
        if entry.get(".tag") != "file":
            continue
        name = entry.get("name") or ""
        if not name.endswith(".zip"):
            continue
        date_part = name[:-4]
        try:
            archive_date = datetime.strptime(date_part, "%Y-%m-%d").date()
        except ValueError:
            continue
        if archive_date >= archive_cutoff:
            continue
        path = entry.get("path_lower") or entry.get("path_display")
        if not path:
            continue
        delete_resp = requests.post(
            DROPBOX_DELETE_URL,
            headers=headers,
            json={"path": path},
            timeout=30,
        )
        if delete_resp.status_code >= 400:
            LOG.warning(
                "Dropbox archive delete failed (%s): %s",
                delete_resp.status_code,
                delete_resp.text,
            )


def _slugify(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return cleaned or "unknown"


def _build_raw_label(args: argparse.Namespace) -> str:
    stamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    parts = ["uk_aq_raw_uk_air_sos", stamp]
    if args.station_like:
        parts.append(_slugify(args.station_like))
    if args.region:
        parts.append(_slugify(args.region))
    return "_".join(parts)


def _build_log_filename(args: argparse.Namespace) -> str:
    stamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    parts = ["uk_aq_log_uk_air_sos", stamp]
    if args.station_like:
        parts.append(_slugify(args.station_like))
    if args.region:
        parts.append(_slugify(args.region))
    return f"{'_'.join(parts)}.log"


def _build_error_filename(created_at: str, error_id: str) -> str:
    try:
        stamp = datetime.fromisoformat(created_at.replace("Z", "+00:00")).strftime("%Y%m%dT%H%M%SZ")
    except ValueError:
        stamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    return f"uk_aq_error_uk_air_sos_{stamp}_{error_id}.json"


def _load_dropbox_config(folder_override: Optional[str]) -> Optional[DropboxConfig]:
    app_key = os.getenv("DROPBOX_APP_KEY", "").strip()
    app_secret = os.getenv("DROPBOX_APP_SECRET", "").strip()
    refresh_token = os.getenv("DROPBOX_REFRESH_TOKEN", "").strip()
    folder = (folder_override or os.getenv("UK_AIR_RAW_DROPBOX_FOLDER") or DEFAULT_RAW_DROPBOX_FOLDER).strip()
    if not (app_key and app_secret and refresh_token):
        LOG.warning("Dropbox credentials missing; skipping raw payload upload.")
        return None
    return DropboxConfig(
        app_key=app_key,
        app_secret=app_secret,
        refresh_token=refresh_token,
        folder=folder,
    )


def _load_error_dropbox_config() -> Optional[DropboxConfig]:
    app_key = os.getenv("DROPBOX_APP_KEY", "").strip()
    app_secret = os.getenv("DROPBOX_APP_SECRET", "").strip()
    refresh_token = os.getenv("DROPBOX_REFRESH_TOKEN", "").strip()
    folder = (os.getenv("UK_AIR_ERROR_DROPBOX_FOLDER") or DEFAULT_ERROR_DROPBOX_FOLDER).strip()
    if not (app_key and app_secret and refresh_token):
        LOG.warning("Dropbox credentials missing; skipping error Dropbox upload.")
        return None
    return DropboxConfig(
        app_key=app_key,
        app_secret=app_secret,
        refresh_token=refresh_token,
        folder=folder,
    )


def _raw_dropbox_allowed() -> bool:
    supabase_url = os.getenv("SUPABASE_URL", "").strip()
    allowed_url = os.getenv("UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL", "").strip()
    if not allowed_url:
        LOG.warning("UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL not set; raw Dropbox upload disabled.")
        return False
    if supabase_url != allowed_url:
        LOG.warning("Raw Dropbox upload disabled (SUPABASE_URL does not match allowed URL).")
        return False
    return True


def _prepare_raw_dropbox_session(args: argparse.Namespace) -> Optional[RawDropboxSession]:
    if not args.raw_dropbox:
        return None
    if not _raw_dropbox_allowed():
        return None
    config = _load_dropbox_config(args.raw_dropbox_folder)
    if not config:
        return None
    temp_dir = tempfile.TemporaryDirectory(prefix="uk_aq_raw_")
    filename = f"{_build_raw_label(args)}.jsonl.gz"
    output_path = Path(temp_dir.name) / filename
    recorder = RawPayloadRecorder(output_path)
    log_path = Path(temp_dir.name) / _build_log_filename(args)
    log_handler = _add_file_logger(log_path, DEFAULT_FILE_LOG_LEVEL)
    LOG.debug("Raw Dropbox capture enabled (output=%s).", output_path.name)
    return RawDropboxSession(
        recorder=recorder,
        config=config,
        temp_dir=temp_dir,
        log_path=log_path,
        log_handler=log_handler,
    )


class UkAirClient:
    def __init__(
        self,
        base_url: str = UK_AIR_SOS_BASE_URL,
        timeout: int = 60,
        retries: int = 3,
        raw_recorder: Optional[RawPayloadRecorder] = None,
    ):
        self.base_url = base_url
        self.timeout = timeout
        self.retries = retries
        self.session = requests.Session()
        self.raw_recorder = raw_recorder

    def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{self.base_url}/{path.lstrip('/')}"
        for attempt in range(1, self.retries + 1):
            try:
                resp = self.session.get(url, params=params, timeout=self.timeout)
                if resp.status_code in (429, 500, 502, 503, 504):
                    self._sleep(attempt)
                    continue
                resp.raise_for_status()
                data = resp.json()
                if self.raw_recorder:
                    self.raw_recorder.record_response(path, params, resp.status_code, data)
                return data
            except requests.HTTPError as exc:
                status = exc.response.status_code if exc.response is not None else "unknown"
                if status == 404:
                    LOG.info(
                        "Request failed (attempt %s/%s): HTTP %s %s",
                        attempt,
                        self.retries,
                        status,
                        self._request_label(path, params),
                    )
                    return {}
                level = logging.INFO if status == 400 else logging.WARNING
                LOG.log(
                    level,
                    "Request failed (attempt %s/%s): HTTP %s %s",
                    attempt,
                    self.retries,
                    status,
                    self._request_label(path, params),
                )
                if attempt == self.retries:
                    raise
                self._sleep(attempt)
            except requests.RequestException as exc:
                LOG.warning(
                    "Request failed (attempt %s/%s): %s",
                    attempt,
                    self.retries,
                    exc,
                )
                if attempt == self.retries:
                    raise
                self._sleep(attempt)
        return {}

    def _sleep(self, attempt: int) -> None:
        delay = min(30, 2**attempt)
        time.sleep(delay)

    def _request_label(self, path: str, params: Optional[Dict[str, Any]]) -> str:
        if not params:
            return path
        station_list = params.get("station") if isinstance(params, dict) else None
        if isinstance(station_list, list):
            return f"{path} (stations={len(station_list)})"
        return f"{path} (params={','.join(sorted(params.keys()))})"

    def services(self) -> List[Dict[str, Any]]:
        data = self.get("/services")
        return _extract_list(data, ("services", "data"))

    def stations(
        self,
        service_ref: str,
        bbox: Optional[Dict[str, float]] = None,
        region: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        bbox_param = None
        if bbox:
            bbox_param = f"{bbox['west']},{bbox['south']},{bbox['east']},{bbox['north']}"
        params_options: List[Dict[str, Any]] = []

        def add_param_sets(expanded: Optional[str]) -> None:
            base = {"service": service_ref}
            if expanded:
                base["expanded"] = expanded
            if bbox_param and region:
                params_options.append({**base, "bbox": bbox_param, "region": region})
            if bbox_param:
                params_options.append({**base, "bbox": bbox_param})
            if region:
                params_options.append({**base, "region": region})
            params_options.append(base.copy())
            if bbox_param:
                params_options.append({"bbox": bbox_param, **({"expanded": expanded} if expanded else {})})
            if region:
                params_options.append({"region": region, **({"expanded": expanded} if expanded else {})})
            if expanded:
                params_options.append({"expanded": expanded})
            params_options.append({})

        add_param_sets("true")
        add_param_sets(None)

        seen = set()
        skip_bbox = False
        for params in params_options:
            key = tuple(sorted(params.items()))
            if key in seen:
                continue
            seen.add(key)
            if skip_bbox and "bbox" in params:
                continue
            try:
                data = self.get("/stations", params=params or None)
                LOG.info("Station query succeeded with params: %s", params or {})
                return _extract_list(data, ("stations", "data"))
            except requests.HTTPError as exc:
                if exc.response is not None and exc.response.status_code == 400:
                    if "bbox" in params:
                        skip_bbox = True
                    LOG.info("Station query failed (400) with params %s; trying fallback.", params)
                    continue
                raise
        return []

    def timeseries(
        self,
        service_ref: str,
        station_ids: Optional[Sequence[str]],
        batch_size: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        series: List[Dict[str, Any]] = []
        if station_ids is None:
            LOG.info("Fetching timeseries without station filter")
            data = self.get("/timeseries", params={"service": service_ref, "expanded": "true"})
            series.extend(_extract_list(data, ("timeseries", "data")))
        else:
            if not station_ids:
                return series
            size = batch_size or DEFAULT_TIMESERIES_STATION_BATCH_SIZE
            if size <= 0:
                size = DEFAULT_TIMESERIES_STATION_BATCH_SIZE
            LOG.info("Fetching timeseries for %s stations in batches of %s", len(station_ids), size)
            for chunk in _chunked(station_ids, size):
                params: Dict[str, Any] = {"service": service_ref, "expanded": "true"}
                for station_id in chunk:
                    params.setdefault("station", []).append(station_id)
                data = self.get("/timeseries", params=params)
                series.extend(_extract_list(data, ("timeseries", "data")))
        return _dedupe_by_id(series)

    def timeseries_data(
        self, series_id: str, timespan: str, format_: str = "tvp"
    ) -> Dict[str, Any]:
        params = {"timespan": timespan, "format": format_}
        return self.get(f"/timeseries/{series_id}/getData", params=params)

    def timeseries_detail(self, series_id: str) -> Optional[Dict[str, Any]]:
        params = {"expanded": "true"}
        data = self.get(f"/timeseries/{series_id}", params=params)
        if isinstance(data, dict):
            for key in ("timeseries", "data"):
                item = data.get(key)
                if isinstance(item, dict):
                    return item
                if isinstance(item, list) and item:
                    return item[0]
        if isinstance(data, dict) and data.get("id"):
            return data
        return None

    def station_detail(self, station_id: str) -> Optional[Dict[str, Any]]:
        params = {"expanded": "true"}
        try:
            data = self.get(f"/stations/{station_id}", params=params)
        except requests.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else None
            if status == 404:
                LOG.warning("Station not found: %s", station_id)
                return None
            raise
        if isinstance(data, dict):
            for key in ("station", "stations", "data"):
                item = data.get(key)
                if isinstance(item, dict):
                    return item
                if isinstance(item, list) and item:
                    return item[0]
        if isinstance(data, list) and data:
            return data[0]
        if isinstance(data, dict) and data.get("id"):
            return data
        return None


class SupabaseWriter:
    def __init__(self) -> None:
        supabase_url = os.getenv("SUPABASE_URL")
        supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if not supabase_url or not supabase_key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")
        self.client: Client = create_client(supabase_url, supabase_key)

    def upsert_connectors(self, services: Iterable[Dict[str, Any]]) -> Optional[int]:
        services_list = [svc for svc in services if isinstance(svc, dict)]
        if not services_list:
            return None
        primary = services_list[0]
        payload = [
            {
                "connector_code": UK_AIR_SOS_CONNECTOR_CODE,
                "label": _normalize_service_label(primary.get("label") or primary.get("name")),
                "service_url": primary.get("serviceUrl") or primary.get("url") or UK_AIR_SOS_BASE_URL,
            }
        ]
        self.client.table("connectors").upsert(payload, on_conflict="connector_code").execute()
        return self.get_connector_id()

    def get_connector_id(self) -> Optional[int]:
        resp = (
            self.client.table("connectors")
            .select("id")
            .eq("connector_code", UK_AIR_SOS_CONNECTOR_CODE)
            .limit(1)
            .execute()
        )
        rows = resp.data if hasattr(resp, "data") else resp.get("data")
        if not rows:
            return None
        row = rows[0] if isinstance(rows, list) else rows
        if not isinstance(row, dict):
            return None
        try:
            return int(row.get("id"))
        except (TypeError, ValueError):
            return None

    def get_connector_settings(self, connector_id: int) -> Dict[str, Optional[object]]:
        try:
            resp = (
                self.client.table("connectors")
                .select("poll_timeseries_batch_size,stations_bbox_supported,timeseries_station_filter_supported")
                .eq("id", connector_id)
                .execute()
            )
        except Exception as exc:
            LOG.warning("Failed to read connectors settings: %s", exc)
            return {
                "poll_timeseries_batch_size": None,
                "stations_bbox_supported": None,
                "timeseries_station_filter_supported": None,
            }
        data = resp.data if hasattr(resp, "data") else resp.get("data")
        if not data:
            return {
                "poll_timeseries_batch_size": None,
                "stations_bbox_supported": None,
                "timeseries_station_filter_supported": None,
            }
        row = data[0] if isinstance(data, list) else data
        if not isinstance(row, dict):
            return {
                "poll_timeseries_batch_size": None,
                "stations_bbox_supported": None,
                "timeseries_station_filter_supported": None,
            }
        batch_size = row.get("poll_timeseries_batch_size")
        bbox_supported = row.get("stations_bbox_supported")
        station_filter_supported = row.get("timeseries_station_filter_supported")
        try:
            batch_int = int(batch_size)
        except (TypeError, ValueError):
            batch_int = None
        if batch_int is not None and batch_int <= 0:
            batch_int = None
        if isinstance(bbox_supported, str):
            bbox_supported = bbox_supported.strip().lower() in {"true", "1", "yes"}
        if not isinstance(bbox_supported, bool):
            bbox_supported = None
        if isinstance(station_filter_supported, str):
            station_filter_supported = station_filter_supported.strip().lower() in {"true", "1", "yes"}
        if not isinstance(station_filter_supported, bool):
            station_filter_supported = None
        return {
            "poll_timeseries_batch_size": batch_int,
            "stations_bbox_supported": bbox_supported,
            "timeseries_station_filter_supported": station_filter_supported,
        }

    def upsert_reference_table(
        self,
        table: str,
        ref_key: str,
        items: Iterable[Dict[str, Any]],
        connector_id: int,
        service_ref: Optional[str] = None,
    ) -> Dict[str, int]:
        payload_by_ref: Dict[str, Dict[str, Any]] = {}
        for item in items:
            if not item or not isinstance(item, dict):
                continue
            ref = item.get("id") or item.get(ref_key)
            if not ref:
                continue
            ref_value = str(ref)
            label = (
                item.get("label")
                or item.get("notation")
                or item.get("eionet_uri")
                or ref_value
            )
            row: Dict[str, Any] = {
                ref_key: ref_value,
                "label": label,
                "connector_id": connector_id,
            }
            if service_ref is not None:
                row["service_ref"] = str(service_ref)
            payload_by_ref.setdefault(ref_value, row)
        payload = list(payload_by_ref.values())
        if payload:
            conflict_keys = ["connector_id"]
            if service_ref is not None:
                conflict_keys.append("service_ref")
            conflict_keys.append(ref_key)
            self.client.table(table).upsert(payload, on_conflict=",".join(conflict_keys)).execute()
        return self.get_ref_id_map(
            table, ref_key, list(payload_by_ref.keys()), connector_id, service_ref
        )

    def upsert_phenomena(
        self,
        items: Iterable[Dict[str, Any]],
        connector_id: int,
    ) -> Dict[str, int]:
        payload_by_uri: Dict[str, Dict[str, Any]] = {}
        for item in items:
            if not item or not isinstance(item, dict):
                continue
            uri = item.get("eionet_uri") or item.get("id")
            if not uri:
                continue
            uri_value = str(uri)
            label = item.get("label") or item.get("notation") or uri_value
            notation = item.get("notation")
            row = payload_by_uri.get(uri_value)
            if row is None:
                row = {
                    "eionet_uri": uri_value,
                    "label": label,
                    "notation": notation,
                    "connector_id": connector_id,
                }
                payload_by_uri[uri_value] = row
                continue
            if label and (not row.get("label") or row.get("label") == uri_value):
                row["label"] = label
            if notation and not row.get("notation"):
                row["notation"] = notation
        payload = list(payload_by_uri.values())
        if payload:
            self.client.table("phenomena").upsert(payload, on_conflict="connector_id,eionet_uri").execute()
        return self.get_phenomena_id_map(list(payload_by_uri.keys()), connector_id)

    def get_ref_id_map(
        self,
        table: str,
        ref_key: str,
        refs: Sequence[str],
        connector_id: int,
        service_ref: Optional[str] = None,
    ) -> Dict[str, int]:
        mapping: Dict[str, int] = {}
        if not refs:
            return mapping
        for chunk in _chunked(list(refs), 500):
            query = (
                self.client.table(table)
                .select(f"id,{ref_key}")
                .eq("connector_id", connector_id)
                .in_(ref_key, chunk)
            )
            if service_ref is not None:
                query = query.eq("service_ref", str(service_ref))
            resp = query.execute()
            rows = resp.data if hasattr(resp, "data") else resp.get("data")
            if not rows:
                continue
            for row in rows:
                mapping[str(row[ref_key])] = int(row["id"])
        return mapping

    def get_phenomena_id_map(self, eionet_uris: Sequence[str], connector_id: int) -> Dict[str, int]:
        mapping: Dict[str, int] = {}
        if not eionet_uris:
            return mapping
        for chunk in _chunked(list(eionet_uris), 500):
            resp = (
                self.client.table("phenomena")
                .select("id,eionet_uri")
                .eq("connector_id", connector_id)
                .in_("eionet_uri", chunk)
                .execute()
            )
            rows = resp.data if hasattr(resp, "data") else resp.get("data")
            if not rows:
                continue
            for row in rows:
                if row.get("eionet_uri"):
                    mapping[str(row["eionet_uri"])] = int(row["id"])
        return mapping

    def upsert_stations(
        self,
        stations: Iterable[Dict[str, Any]],
        connector_id: int,
        service_ref: str,
        category_id_map: Optional[Dict[str, int]] = None,
        bbox: Optional[Dict[str, float]] = None,
    ) -> None:
        rows = []
        effective_bbox = bbox or UK_BBOX
        for station in stations:
            lon, lat = station_coords(station, bbox=effective_bbox)
            props = station.get("properties", {})
            station_ref = station.get("id") or props.get("id")
            if not station_ref:
                continue
            label = station.get("label") or props.get("label")
            station_name = _derive_station_name(label)
            category_ref = None
            if isinstance(props.get("category"), dict):
                category_ref = props.get("category", {}).get("id")
            category_id = None
            if category_id_map and category_ref is not None:
                category_id = category_id_map.get(str(category_ref))
            row = {
                "station_ref": str(station_ref),
                "label": label,
                "station_type": props.get("stationType") or station.get("stationType"),
                "region": props.get("region") or station.get("region"),
                "geometry": (
                    f"SRID=4326;POINT({lon} {lat})"
                    if lon is not None and lat is not None
                    else None
                ),
                "connector_id": connector_id,
                "service_ref": str(service_ref),
                "category_id": category_id,
            }
            if station_name:
                row["station_name"] = station_name
            rows.append(row)
        if rows:
            self.client.table("stations").upsert(
                rows, on_conflict="connector_id,service_ref,station_ref"
            ).execute()

    def upsert_timeseries(
        self,
        series: Iterable[Dict[str, Any]],
        connector_id: int,
        service_ref: str,
        station_id_map: Dict[str, int],
        category_id_map: Dict[str, int],
        feature_id_map: Dict[str, int],
        procedure_id_map: Dict[str, int],
        offering_id_map: Dict[str, int],
        phenomenon_id_map: Dict[str, int],
        station_label_map: Optional[Dict[str, List[int]]] = None,
        station_geometry_by_id: Optional[Dict[int, Tuple[float, float]]] = None,
    ) -> int:
        rows = []
        label_match_count = 0
        for ts in series:
            station_ref = _extract_station_ref(ts)
            if station_ref is None:
                station_ref = _extract_station_ref_from_label(ts.get("label"))
            feature_payload = _extract_feature_payload(ts)
            feature_ref = _extract_ref_id(feature_payload) if feature_payload else None
            station_db_id = station_id_map.get(str(station_ref)) if station_ref is not None else None
            if station_db_id is None and station_label_map:
                descriptor = _extract_station_descriptor_from_label(ts.get("label"))
                if descriptor:
                    descriptor_key = _normalize_station_label(descriptor)
                    matches = station_label_map.get(descriptor_key) or []
                    chosen = _choose_station_id_by_geometry(matches, station_geometry_by_id)
                    if chosen is not None:
                        station_db_id = chosen
                        label_match_count += 1
                if station_db_id is None:
                    station_name = _extract_station_name_from_label(ts.get("label"))
                    if station_name:
                        label_key = _normalize_station_label(station_name)
                        matches = station_label_map.get(label_key) or []
                        chosen = _choose_station_id_by_geometry(matches, station_geometry_by_id)
                        if chosen is not None:
                            station_db_id = chosen
                            label_match_count += 1
            category_ref = ts.get("category", {}).get("id") if isinstance(ts.get("category"), dict) else None
            procedure_ref = ts.get("procedure", {}).get("id") if isinstance(ts.get("procedure"), dict) else None
            offering_ref = ts.get("offering", {}).get("id") if isinstance(ts.get("offering"), dict) else None
            phen_uri = ts.get("phenomenon", {}).get("eionet_uri") if isinstance(ts.get("phenomenon"), dict) else None
            rows.append(
                {
                    "timeseries_ref": str(ts.get("id")) if ts.get("id") is not None else None,
                    "label": ts.get("label"),
                    "uom": ts.get("uom"),
                    "station_id": station_db_id,
                    "connector_id": connector_id,
                    "service_ref": str(service_ref),
                    "offering_id": offering_id_map.get(str(offering_ref)) if offering_ref is not None else None,
                    "feature_id": feature_id_map.get(str(feature_ref)) if feature_ref is not None else None,
                    "procedure_id": procedure_id_map.get(str(procedure_ref)) if procedure_ref is not None else None,
                    "phenomenon_id": phenomenon_id_map.get(str(phen_uri)) if phen_uri else None,
                    "category_id": category_id_map.get(str(category_ref)) if category_ref is not None else None,
                    "first_value_at": _parse_timestamp(ts.get("firstValueTimestamp")),
                    "last_value_at": _parse_timestamp(ts.get("lastValueTimestamp")),
                    "last_value": _safe_number(ts.get("lastValue")),
                    "extras": ts.get("extras") or ts.get("parameters"),
                    "rendering_hints": ts.get("renderingHints"),
                    "status_intervals": ts.get("statusIntervals"),
                }
            )
        rows = [row for row in rows if row.get("timeseries_ref")]
        if rows:
            self.client.table("timeseries").upsert(
                rows, on_conflict="connector_id,service_ref,timeseries_ref"
            ).execute()
        return label_match_count

    def get_station_id_map(
        self, connector_id: int, service_ref: str, station_refs: Sequence[str]
    ) -> Dict[str, int]:
        return self.get_ref_id_map("stations", "station_ref", station_refs, connector_id, service_ref)

    def get_timeseries_id_map(
        self, connector_id: int, service_ref: str, timeseries_refs: Sequence[str]
    ) -> Dict[str, int]:
        return self.get_ref_id_map("timeseries", "timeseries_ref", timeseries_refs, connector_id, service_ref)

    def get_station_label_map(self, connector_id: int, service_ref: str) -> Dict[str, List[int]]:
        label_map: Dict[str, List[int]] = {}
        offset = 0
        batch_size = 1000
        while True:
            resp = (
                self.client.table("stations")
                .select("id,label")
                .eq("connector_id", connector_id)
                .eq("service_ref", str(service_ref))
                .order("id", desc=False)
                .range(offset, offset + batch_size - 1)
                .execute()
            )
            rows = resp.data if hasattr(resp, "data") else resp.get("data")
            if not rows:
                break
            for row in rows:
                label = row.get("label")
                if not label:
                    continue
                label_text = str(label)
                key_full = _normalize_station_label(label_text)
                if key_full:
                    label_map.setdefault(key_full, []).append(int(row["id"]))
                base_name = _extract_station_name_from_label(label_text)
                if base_name:
                    key_base = _normalize_station_label(base_name)
                    if key_base and key_base != key_full:
                        label_map.setdefault(key_base, []).append(int(row["id"]))
            offset += batch_size
        return label_map

    def get_station_label_geometry_map(
        self, connector_id: int, service_ref: str
    ) -> Tuple[Dict[str, List[int]], Dict[int, str]]:
        label_map: Dict[str, List[int]] = {}
        geometry_by_id: Dict[int, str] = {}
        offset = 0
        batch_size = 1000
        while True:
            resp = (
                self.client.table("stations")
                .select("id,label,geometry")
                .eq("connector_id", connector_id)
                .eq("service_ref", str(service_ref))
                .order("id", desc=False)
                .range(offset, offset + batch_size - 1)
                .execute()
            )
            rows = resp.data if hasattr(resp, "data") else resp.get("data")
            if not rows:
                break
            for row in rows:
                label = row.get("label")
                if not label:
                    continue
                label_text = str(label)
                key_full = _normalize_station_label(label_text)
                if key_full:
                    label_map.setdefault(key_full, []).append(int(row["id"]))
                base_name = _extract_station_name_from_label(label_text)
                if base_name:
                    key_base = _normalize_station_label(base_name)
                    if key_base and key_base != key_full:
                        label_map.setdefault(key_base, []).append(int(row["id"]))
                key = _geometry_key(row.get("geometry"))
                if key is not None:
                    geometry_by_id[int(row["id"])] = key
            offset += batch_size
        return label_map, geometry_by_id

    def get_station_geometry_index(
        self, connector_id: int, service_ref: str
    ) -> Dict[str, List[Dict[str, Any]]]:
        index: Dict[str, List[Dict[str, Any]]] = {}
        offset = 0
        batch_size = 1000
        while True:
            resp = (
                self.client.table("stations")
                .select("id,label,geometry,station_type,region")
                .eq("connector_id", connector_id)
                .eq("service_ref", str(service_ref))
                .order("id", desc=False)
                .range(offset, offset + batch_size - 1)
                .execute()
            )
            rows = resp.data if hasattr(resp, "data") else resp.get("data")
            if not rows:
                break
            for row in rows:
                label = row.get("label")
                if not label:
                    continue
                base_name = _extract_station_name_from_label(str(label)) or str(label)
                key = _normalize_station_label(base_name)
                if not key:
                    continue
                index.setdefault(key, []).append(row)
            offset += batch_size
        return index

    def upsert_observations(
        self, series_id: int, datapoints: Iterable[Dict[str, Any]]
    ) -> None:
        deduped: Dict[str, Dict[str, Any]] = {}
        observed_points = 0
        for point in datapoints:
            observed_at = point.get("observed_at")
            if not observed_at:
                continue
            observed_points += 1
            if isinstance(observed_at, datetime):
                observed_key = observed_at.isoformat()
                observed_value = observed_key
            else:
                observed_key = str(observed_at)
                observed_value = observed_at
            deduped[observed_key] = {
                "timeseries_id": series_id,
                "observed_at": observed_value,
                "value": point.get("value"),
                "status": point.get("status"),
            }
        rows = list(deduped.values())
        if observed_points and len(rows) < observed_points:
            LOG.warning(
                "Dropping %d duplicate observation(s) for timeseries_id=%s during upsert.",
                observed_points - len(rows),
                series_id,
            )
        if rows:
            for attempt in range(1, 4):
                try:
                    self.client.table("observations").upsert(
                        rows, on_conflict="timeseries_id,observed_at"
                    ).execute()
                    break
                except Exception as exc:
                    if not _is_transient_postgrest_error(exc) or attempt == 3:
                        raise
                    LOG.warning(
                        "Observation upsert failed (attempt %s/3) for timeseries_id=%s: %s",
                        attempt,
                        series_id,
                        exc,
                    )
                    time.sleep(min(30, 2**attempt))

    def update_last_value(
        self,
        series_id: int,
        last_value_at: Optional[Any],
        last_value: Optional[float],
    ) -> None:
        parsed_last_value_at = (
            last_value_at
            if isinstance(last_value_at, datetime)
            else _parse_timestamp(last_value_at)
        )
        if parsed_last_value_at is None and last_value is None:
            return
        payload: Dict[str, Any] = {}
        if parsed_last_value_at is not None:
            payload["last_value_at"] = parsed_last_value_at.isoformat()
        if last_value is not None:
            payload["last_value"] = last_value
        if not payload:
            return
        self.client.table("timeseries").update(payload).eq("id", series_id).execute()


class UkAirIngestor:
    def __init__(self, client: UkAirClient, writer: SupabaseWriter, error_logger: Optional[ErrorLogger]) -> None:
        self.client = client
        self.writer = writer
        self.error_logger = error_logger

    def _log_error(
        self,
        message: str,
        exc: BaseException,
        *,
        context: Optional[Dict[str, Any]] = None,
        connector_id: Optional[int] = None,
        station_id: Optional[int] = None,
        timeseries_id: Optional[int] = None,
    ) -> None:
        if not self.error_logger:
            return
        self.error_logger.log_error(
            source="ingest",
            severity="error",
            message=message,
            context=context,
            connector_id=connector_id,
            station_id=station_id,
            timeseries_id=timeseries_id,
            exc=exc,
        )

    def discover_service(
        self,
        preferred_ref: Optional[str],
        preferred_label: Optional[str],
    ) -> ConnectorContext:
        services = self.client.services()
        if not services:
            raise RuntimeError("No services returned from UK-AIR SOS.")
        chosen: Optional[Dict[str, Any]] = None
        if preferred_ref:
            for svc in services:
                if str(svc.get("id")) == str(preferred_ref):
                    chosen = svc
                    break
            if not chosen:
                LOG.warning("Preferred service ref %s not found; falling back.", preferred_ref)
        if not chosen and preferred_label:
            needle = preferred_label.strip().lower()
            for svc in services:
                label = (svc.get("label") or "").lower()
                if needle and needle in label:
                    chosen = svc
                    break
        if not chosen:
            for svc in services:
                label = (svc.get("label") or "").lower()
                if "uk" in label and "air" in label:
                    chosen = svc
                    break
        if not chosen:
            chosen = services[0]
        connector_id = self.writer.upsert_connectors([chosen])
        if connector_id is None:
            connector_id = self.writer.get_connector_id()
        if connector_id is None:
            raise RuntimeError("Failed to resolve connector id for uk_air_sos.")
        raw_service_ref = chosen.get("id")
        if raw_service_ref is None:
            raise RuntimeError("Selected SOS service is missing an id.")
        service_ref = str(raw_service_ref)
        label = _normalize_service_label(chosen.get("label") or chosen.get("name")) or UK_AIR_SOS_SERVICE_LABEL
        service_url = chosen.get("serviceUrl") or chosen.get("url") or UK_AIR_SOS_BASE_URL
        return ConnectorContext(
            id=connector_id,
            service_ref=service_ref,
            label=label,
            service_url=service_url,
        )

    def discover_stations(
        self,
        connector: ConnectorContext,
        bbox: Optional[Dict[str, float]],
        region: Optional[str],
        station_types: Optional[Sequence[str]],
        allow_missing_coords: bool,
        station_like: Optional[str],
    ) -> List[Dict[str, Any]]:
        raw_stations = self.client.stations(connector.service_ref, bbox=bbox, region=region)
        stations = []
        for stn in raw_stations:
            if bbox or region:
                if not _station_matches_area(stn, bbox, region, allow_missing_coords):
                    continue
            if station_like and not _station_label_matches(stn, station_like):
                continue
            if station_types:
                stn_type = _station_type(stn)
                if not stn_type or stn_type.lower() not in station_types:
                    continue
            stations.append(stn)
        if not stations and raw_stations:
            sample = raw_stations[0]
            props = sample.get("properties") if isinstance(sample.get("properties"), dict) else {}
            LOG.warning(
                "Station filtering removed all items; sample keys=%s properties=%s",
                list(sample.keys()),
                list(props.keys()),
            )
        category_items = []
        for stn in stations:
            props = stn.get("properties") if isinstance(stn.get("properties"), dict) else {}
            category = props.get("category") if isinstance(props.get("category"), dict) else None
            if category:
                category_items.append(category)
        category_map = self.writer.upsert_reference_table(
            "categories",
            "category_ref",
            category_items,
            connector.id,
        )
        self.writer.upsert_stations(
            stations,
            connector.id,
            connector.service_ref,
            category_map,
            bbox=bbox,
        )
        return stations

    def discover_timeseries(
        self,
        connector: ConnectorContext,
        station_refs: Optional[Sequence[str]],
        pollutants: Optional[Sequence[str]],
        batch_size: Optional[int],
        sample_count: int,
    ) -> List[Dict[str, Any]]:
        series = self.client.timeseries(connector.service_ref, station_refs, batch_size=batch_size)
        LOG.info("Timeseries fetched: %s", len(series))
        resolver = EionetPollutantResolver()
        for ts in series:
            _ensure_phenomenon(ts, resolver)
        if sample_count > 0 and series:
            for sample in series[:sample_count]:
                LOG.info("Timeseries sample: %s", _summarize_timeseries(sample))
        pollutant_set = {p.lower() for p in pollutants} if pollutants else set()
        if pollutant_set:
            filtered = [
                ts
                for ts in series
                if _matches_pollutant(ts, pollutant_set)
            ]
            LOG.info("Timeseries filtered: %s (pollutants=%s)", len(filtered), sorted(pollutant_set))
            if not filtered and series:
                sample = _sample_phenomena(series, limit=5)
                LOG.info("No timeseries matched pollutants; sample phenomena=%s", sample)
        else:
            filtered = series
        phenomenon_map = self.writer.upsert_phenomena(
            (ts.get("phenomenon") or {} for ts in filtered),
            connector.id,
        )
        procedure_map = self.writer.upsert_reference_table(
            "procedures",
            "procedure_ref",
            (ts.get("procedure") or {} for ts in filtered),
            connector.id,
            connector.service_ref,
        )
        offering_map = self.writer.upsert_reference_table(
            "offerings",
            "offering_ref",
            (ts.get("offering") or {} for ts in filtered),
            connector.id,
            connector.service_ref,
        )
        feature_map = self.writer.upsert_reference_table(
            "features",
            "feature_ref",
            _timeseries_feature_items(filtered),
            connector.id,
            connector.service_ref,
        )
        category_map = self.writer.upsert_reference_table(
            "categories",
            "category_ref",
            (ts.get("category") or {} for ts in filtered),
            connector.id,
        )
        station_refs_to_map: List[str] = []
        if station_refs is not None:
            station_refs_to_map = [
                str(station_ref) for station_ref in station_refs if station_ref is not None
            ]
        else:
            for ts in filtered:
                station_value = _extract_station_ref(ts)
                if station_value is None:
                    station_value = _extract_station_ref_from_label(ts.get("label"))
                if station_value is not None:
                    station_refs_to_map.append(str(station_value))
        station_refs_to_map = list(dict.fromkeys(station_refs_to_map))
        station_id_map = self.writer.get_station_id_map(
            connector.id, connector.service_ref, station_refs_to_map
        )
        missing_refs: List[str] = [
            ref for ref in station_refs_to_map if ref not in station_id_map
        ]
        if missing_refs:
            LOG.warning(
                "Timeseries references %s station(s) not in DB; fetching stations without filters.",
                len(missing_refs),
            )
            extra_stations: List[Dict[str, Any]] = self.client.stations(
                connector.service_ref,
                bbox=None,
                region=None,
            )
            if extra_stations:
                extra_categories: List[Dict[str, Any]] = []
                for stn in extra_stations:
                    props = stn.get("properties") if isinstance(stn.get("properties"), dict) else {}
                    category = props.get("category") if isinstance(props.get("category"), dict) else None
                    if category:
                        extra_categories.append(category)
                extra_category_map = self.writer.upsert_reference_table(
                    "categories",
                    "category_ref",
                    extra_categories,
                    connector.id,
                )
                self.writer.upsert_stations(
                    extra_stations,
                    connector.id,
                    connector.service_ref,
                    extra_category_map,
                    bbox=UK_BBOX,
                )
                station_id_map = self.writer.get_station_id_map(
                    connector.id, connector.service_ref, station_refs_to_map
                )
                still_missing = [ref for ref in station_refs_to_map if ref not in station_id_map]
                if still_missing:
                    LOG.warning(
                        "Still missing %s station id(s) after station refresh.",
                        len(still_missing),
                    )
                    fetched = []
                    for ref in still_missing:
                        detail = self.client.station_detail(str(ref))
                        if detail:
                            fetched.append(detail)
                    if fetched:
                        fetched_categories: List[Dict[str, Any]] = []
                        for stn in fetched:
                            props = stn.get("properties") if isinstance(stn.get("properties"), dict) else {}
                            category = props.get("category") if isinstance(props.get("category"), dict) else None
                            if category:
                                fetched_categories.append(category)
                        fetched_category_map = self.writer.upsert_reference_table(
                            "categories",
                            "category_ref",
                            fetched_categories,
                            connector.id,
                        )
                        self.writer.upsert_stations(
                            fetched,
                            connector.id,
                            connector.service_ref,
                            fetched_category_map,
                            bbox=UK_BBOX,
                        )
                        station_id_map = self.writer.get_station_id_map(
                            connector.id, connector.service_ref, station_refs_to_map
                        )
                        still_missing = [ref for ref in station_refs_to_map if ref not in station_id_map]
                    if still_missing:
                        LOG.warning(
                            "Still missing %s station id(s) after station detail fetch.",
                            len(still_missing),
                        )
            else:
                LOG.warning("Station refresh returned no rows; missing station IDs may remain.")
        station_index = self.writer.get_station_geometry_index(
            connector.id,
            connector.service_ref,
        )
        created_rows = []
        for ref in station_refs_to_map:
            if ref in station_id_map:
                continue
            label = None
            for ts in filtered:
                station_value = _extract_station_ref(ts) or _extract_station_ref_from_label(
                    ts.get("label")
                )
                if station_value is None or str(station_value) != ref:
                    continue
                label = ts.get("label")
                if label:
                    break
            station_name = _extract_station_name_from_label(label)
            if not station_name:
                continue
            station_label = _extract_station_descriptor_from_label(label) or station_name
            seed = _infer_station_seed_from_index(station_index, station_name)
            if not seed:
                continue
            row = {
                "connector_id": connector.id,
                "service_ref": connector.service_ref,
                "station_ref": ref,
                "label": station_label,
                "station_name": station_name,
                "geometry": seed["geometry"],
            }
            if seed.get("station_type"):
                row["station_type"] = seed["station_type"]
            if seed.get("region"):
                row["region"] = seed["region"]
            created_rows.append(row)
        if created_rows:
            self.writer.client.table("stations").upsert(
                created_rows,
                on_conflict="connector_id,service_ref,station_ref",
                returning="minimal",
            ).execute()
            LOG.info(
                "Created %s station row(s) from timeseries labels (connector_id=%s service_ref=%s).",
                len(created_rows),
                connector.id,
                connector.service_ref,
            )
            for row in created_rows:
                LOG.info(
                    "Created station row (connector_id=%s service_ref=%s station_ref=%s label=%s geometry=%s).",
                    connector.id,
                    connector.service_ref,
                    row.get("station_ref"),
                    row.get("label"),
                    row.get("geometry"),
                )
            station_id_map = self.writer.get_station_id_map(
                connector.id, connector.service_ref, station_refs_to_map
            )
        station_label_map, station_geometry_by_id = self.writer.get_station_label_geometry_map(
            connector.id, connector.service_ref
        )
        label_matches = self.writer.upsert_timeseries(
            filtered,
            connector.id,
            connector.service_ref,
            station_id_map,
            category_map,
            feature_map,
            procedure_map,
            offering_map,
            phenomenon_map,
            station_label_map=station_label_map,
            station_geometry_by_id=station_geometry_by_id,
        )
        if label_matches:
            LOG.info(
                "Assigned station_id via label fallback for %s timeseries rows (connector_id=%s service_ref=%s label=%s).",
                label_matches,
                connector.id,
                connector.service_ref,
                connector.label,
            )
        timeseries_id_map = self.writer.get_timeseries_id_map(
            connector.id,
            connector.service_ref,
            [str(ts.get("id")) for ts in filtered if ts.get("id")],
        )
        for ts in filtered:
            ts_ref = ts.get("id")
            if ts_ref is None:
                continue
            ts["_db_id"] = timeseries_id_map.get(str(ts_ref))
        return filtered

    def backfill_year(
        self,
        series: Sequence[Dict[str, Any]],
        year: int,
        chunk_days: int = 31,
        connector_id: Optional[int] = None,
    ) -> int:
        errors = 0
        start = datetime(year, 1, 1, tzinfo=timezone.utc)
        end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
        eligible = [ts for ts in series if ts.get("id") is not None and ts.get("_db_id") is not None]
        total = len(eligible)
        _progress_start(f"Backfill {year}", total)
        for idx, ts in enumerate(eligible, start=1):
            ts_ref = ts.get("id")
            ts_db_id = ts.get("_db_id")
            try:
                LOG.debug("Backfilling %s for %s", ts_ref, year)
                for chunk_start in _range_chunks(start, end, timedelta(days=chunk_days)):
                    chunk_end = min(chunk_start + timedelta(days=chunk_days), end)
                    timespan = f"{chunk_start.isoformat()}/{chunk_end.isoformat()}"
                    data = self.client.timeseries_data(str(ts_ref), timespan)
                    points = _parse_datapoints(data.get("values", []))
                    self.writer.upsert_observations(ts_db_id, points)
                    if points:
                        last_val = points[-1]["value"]
                        last_at = points[-1]["observed_at"]
                    else:
                        last_val = data.get("lastValue")
                        last_at = _parse_timestamp(data.get("lastValueTimestamp"))
                    self.writer.update_last_value(ts_db_id, last_at, _safe_number(last_val))
            except Exception as exc:
                errors += 1
                LOG.debug("Backfill failed for %s: %s", ts_ref, exc)
                self._log_error(
                    "Backfill failed for timeseries.",
                    exc,
                    context={"timeseries_ref": ts_ref, "year": year},
                    connector_id=connector_id,
                    timeseries_id=ts_db_id,
                )
            _progress_tick(idx, total)
        _progress_done(f"Backfill {year}", total)
        return errors

    def refresh_recent(
        self,
        series: Sequence[Dict[str, Any]],
        hours: int = 6,
        connector_id: Optional[int] = None,
    ) -> int:
        errors = 0
        window_start = utcnow() - timedelta(hours=hours)
        window_end = utcnow()
        timespan = f"{window_start.isoformat()}/{window_end.isoformat()}"
        eligible = [ts for ts in series if ts.get("id") is not None and ts.get("_db_id") is not None]
        total = len(eligible)
        _progress_start(f"Refresh recent ({hours}h)", total)
        for idx, ts in enumerate(eligible, start=1):
            ts_ref = ts.get("id")
            ts_db_id = ts.get("_db_id")
            try:
                LOG.debug("Refreshing recent window for %s (%sh)", ts_ref, hours)
                data = self.client.timeseries_data(str(ts_ref), timespan)
                points = _parse_datapoints(data.get("values", []))
                self.writer.upsert_observations(ts_db_id, points)
                if points:
                    last_val = points[-1]["value"]
                    last_at = points[-1]["observed_at"]
                else:
                    last_val = data.get("lastValue")
                    last_at = _parse_timestamp(data.get("lastValueTimestamp"))
                self.writer.update_last_value(ts_db_id, last_at, _safe_number(last_val))
            except Exception as exc:
                errors += 1
                LOG.debug("Refresh failed for %s: %s", ts_ref, exc)
                self._log_error(
                    "Refresh failed for timeseries.",
                    exc,
                    context={"timeseries_ref": ts_ref, "window_hours": hours},
                    connector_id=connector_id,
                    timeseries_id=ts_db_id,
                )
            _progress_tick(idx, total)
        _progress_done(f"Refresh recent ({hours}h)", total)
        return errors


def _parse_datapoints(values: Any) -> List[Dict[str, Any]]:
    datapoints: List[Dict[str, Any]] = []
    if isinstance(values, dict):
        if isinstance(values.get("values"), list):
            values_iter: Iterable[Any] = values["values"]
        elif isinstance(values.get("data"), list):
            values_iter = values["data"]
        else:
            values_iter = list(values.items())
    else:
        values_iter = values

    for row in values_iter:
        timestamp_ms = None
        value = None
        status = None
        if isinstance(row, dict):
            timestamp_ms = (
                row.get("time")
                or row.get("timestamp")
                or row.get("t")
                or row.get("dateTime")
                or row.get("phenomenonTime")
                or row.get("observed_at")
            )
            value = row.get("value") or row.get("v") or row.get("result")
            status = row.get("status") or row.get("s")
        elif isinstance(row, (list, tuple)):
            if len(row) < 2:
                continue
            timestamp_ms = row[0]
            value = row[1]
            status = row[2] if len(row) > 2 else None
        else:
            continue
        obs_time = _parse_timestamp(timestamp_ms)
        if obs_time is None:
            continue
        datapoints.append(
            {"observed_at": obs_time.isoformat(), "value": _safe_number(value), "status": status}
        )
    return datapoints


def _normalize_service_label(label: Optional[str]) -> Optional[str]:
    if label is None:
        return UK_AIR_SOS_SERVICE_LABEL
    trimmed = label.strip()
    if not trimmed:
        return UK_AIR_SOS_SERVICE_LABEL
    if trimmed.lower().startswith("my timeseries service"):
        return UK_AIR_SOS_SERVICE_LABEL
    return trimmed


def _extract_list(payload: Any, keys: Sequence[str]) -> List[Dict[str, Any]]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in keys:
            items = payload.get(key)
            if isinstance(items, list):
                return items
    return []


def _station_matches_area(
    station: Dict[str, Any],
    bbox: Optional[Dict[str, float]],
    region: Optional[str],
    allow_missing_coords: bool,
) -> bool:
    if bbox:
        if allow_missing_coords:
            if station_in_bbox_or_missing_coords(station, bbox):
                return True
        else:
            if station_in_bbox(station, bbox):
                return True
    station_region = _station_region(station)
    if region and station_region:
        return station_region.strip().lower() == region.strip().lower()
    station_label = _station_label(station)
    if region and station_label and region.strip().lower() in station_label.strip().lower():
        return True
    if not bbox and not region:
        return True
    return False


def _station_region(station: Dict[str, Any]) -> Optional[str]:
    props = station.get("properties", {}) if isinstance(station.get("properties"), dict) else {}
    return props.get("region") or station.get("region")


def _station_label(station: Dict[str, Any]) -> Optional[str]:
    props = station.get("properties", {}) if isinstance(station.get("properties"), dict) else {}
    return station.get("label") or props.get("label") or station.get("name")


def _station_label_matches(station: Dict[str, Any], match: str) -> bool:
    if not match:
        return True
    label = _station_label(station)
    if not label:
        return False
    return match.strip().lower() in label.strip().lower()


def _station_type(station: Dict[str, Any]) -> Optional[str]:
    props = station.get("properties", {}) if isinstance(station.get("properties"), dict) else {}
    return props.get("stationType") or station.get("stationType")


def _parse_timestamp(raw: Any) -> Optional[datetime]:
    if raw is None:
        return None
    try:
        if isinstance(raw, (int, float)):
            return datetime.fromtimestamp(raw / 1000, tz=timezone.utc)
        if isinstance(raw, str):
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None
    return None


def _safe_number(raw: Any) -> Optional[float]:
    try:
        if raw is None:
            return None
        num = float(raw)
        if num != num:  # NaN guard
            return None
        return num
    except (ValueError, TypeError):
        return None


def _is_transient_postgrest_error(exc: Exception) -> bool:
    text = str(exc).lower()
    if "json could not be generated" in text:
        return True
    if "cloudflare" in text or "internal server error" in text:
        return True
    match = re.search(r"code[^0-9]*([0-9]{3})", text)
    if match:
        try:
            code = int(match.group(1))
        except ValueError:
            code = 0
        if 500 <= code <= 599:
            return True
    return False


def _resolve_uniform_value(values: Iterable[Optional[str]]) -> Optional[str]:
    unique = {value for value in values if value not in (None, "")}
    if len(unique) == 1:
        return next(iter(unique))
    return None


def _range_chunks(start: datetime, end: datetime, step: timedelta) -> Iterable[datetime]:
    cursor = start
    while cursor < end:
        yield cursor
        cursor += step


def _chunked(values: Sequence[str], size: int) -> Iterable[Sequence[str]]:
    if size <= 0:
        size = 50
    for idx in range(0, len(values), size):
        yield values[idx : idx + size]


def _parse_csv_arg(value: Optional[str]) -> Optional[List[str]]:
    if value is None:
        return None
    parts = [item.strip() for item in value.split(",")]
    cleaned = [item for item in parts if item]
    return cleaned or None


def _parse_bbox_arg(value: Optional[str]) -> Optional[Dict[str, float]]:
    if value is None:
        return UK_BBOX
    raw = value.strip()
    if not raw:
        return UK_BBOX
    lowered = raw.lower()
    if lowered in {"none", "null"}:
        return None
    if lowered in {"uk", "gb", "greatbritain"}:
        return UK_BBOX
    parts = [item.strip() for item in raw.split(",")]
    if len(parts) != 4:
        raise ValueError("bbox must be west,south,east,north")
    west, south, east, north = (float(val) for val in parts)
    return {"west": west, "south": south, "east": east, "north": north}


def _dedupe_by_id(items: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = {}
    for item in items:
        item_id = item.get("id")
        if not item_id:
            continue
        seen[item_id] = item
    return list(seen.values())


def _normalize_pollutant_text(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


_STATION_LABEL_POLLUTANT_HINTS = (
    "sulphur",
    "sulfur",
    "nitrogen",
    "ozone",
    "particulate",
    "pm10",
    "pm25",
    "pm2",
    "carbon",
    "benzene",
    "toluene",
    "monoxide",
    "dioxide",
    "oxide",
    "lead",
    "so2",
    "no2",
    "no",
    "co",
)


def _normalize_station_label(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def _geometry_key(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if re.fullmatch(r"[0-9A-Fa-f]+", text):
            return text.lower()
        match = re.search(r"POINT\\s*\\(\\s*(-?\\d+(?:\\.\\d+)?)\\s+(-?\\d+(?:\\.\\d+)?)\\s*\\)", text)
        if match:
            lon = _safe_number(match.group(1))
            lat = _safe_number(match.group(2))
            if lon is not None and lat is not None:
                return f"point:{lon:.6f},{lat:.6f}"
        return None
    if isinstance(value, dict):
        coords = value.get("coordinates")
        if isinstance(coords, (list, tuple)) and len(coords) >= 2:
            lon = _safe_number(coords[0])
            lat = _safe_number(coords[1])
            if lon is not None and lat is not None:
                return f"point:{lon:.6f},{lat:.6f}"
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        lon = _safe_number(value[0])
        lat = _safe_number(value[1])
        if lon is not None and lat is not None:
            return f"point:{lon:.6f},{lat:.6f}"
    return None


def _choose_station_id_by_geometry(
    matches: List[int],
    geometry_by_id: Optional[Dict[int, str]],
) -> Optional[int]:
    if not matches:
        return None
    if len(matches) == 1:
        return matches[0]
    if not geometry_by_id:
        return None
    keys = [geometry_by_id.get(match) for match in matches]
    if any(key is None for key in keys):
        return None
    first = keys[0]
    if all(first == key for key in keys[1:]):
        return min(matches)
    return None


def _infer_station_seed_from_index(
    station_index: Dict[str, List[Dict[str, Any]]],
    station_name: str,
) -> Optional[Dict[str, Any]]:
    key = _normalize_station_label(station_name)
    if not key:
        return None
    rows = station_index.get(key)
    if not rows:
        return None
    geom_values = [row.get("geometry") for row in rows if row.get("geometry") is not None]
    geom_keys = [_geometry_key(value) for value in geom_values]
    geom_keys = [geom_key for geom_key in geom_keys if geom_key is not None]
    if not geom_keys:
        return None
    first_key = geom_keys[0]
    if not all(first_key == geom_key for geom_key in geom_keys[1:]):
        return None
    station_type = _resolve_uniform_value(row.get("station_type") for row in rows)
    region = _resolve_uniform_value(row.get("region") for row in rows)
    return {
        "geometry": geom_values[0],
        "station_type": station_type,
        "region": region,
    }


def _extract_station_ref_from_label(label: Optional[str]) -> Optional[str]:
    if not label:
        return None
    match = re.search(r"pollutant/\d+\s+(\d+)\s+-", label)
    if match:
        return match.group(1)
    match = re.search(r"\s(\d+)\s+-", label)
    if match:
        return match.group(1)
    return None


def _extract_station_descriptor_from_label(label: Optional[str]) -> Optional[str]:
    if not label:
        return None
    text = label.strip()
    if not text:
        return None
    match = re.match(r"^https?://\S+\s+\d+\s+-\s+(.*)$", text)
    if not match:
        match = re.match(r"^\S+\s+\d+\s+-\s+(.*)$", text)
    if not match:
        match = re.match(r"^\d+\s+-\s+(.*)$", text)
    if match:
        text = match.group(1)
    if "," in text:
        text = text.split(",", 1)[0]
    text = text.strip()
    return text or None


def _looks_like_pollutant_suffix(value: str) -> bool:
    normalized = _normalize_station_label(value)
    if any(hint in normalized for hint in _STATION_LABEL_POLLUTANT_HINTS):
        return True
    lowered = value.lower()
    return any(token in lowered for token in ("(air)", "micro", "aerosol"))


def _extract_station_name_from_label(label: Optional[str]) -> Optional[str]:
    text = _extract_station_descriptor_from_label(label)
    if not text:
        return None
    if " - " in text:
        candidate = text.split(" - ", 1)[0].strip()
        if candidate:
            return candidate
    if "-" in text:
        left, right = text.rsplit("-", 1)
        if _looks_like_pollutant_suffix(right):
            candidate = left.strip()
            if candidate:
                return candidate
    return text


def _derive_station_name(label: Optional[str]) -> Optional[str]:
    if not label:
        return None
    cleaned = _extract_station_name_from_label(label)
    if cleaned:
        return cleaned
    trimmed = label.strip()
    return trimmed or None


def _expand_pollutant_terms(pollutant_set: Set[str]) -> Set[str]:
    aliases = {
        "no2": {"no2", "nitrogendioxide"},
        "o3": {"o3", "ozone"},
        "pm10": {"pm10", "particulatematter10"},
        "pm25": {"pm25", "pm2.5", "particulatematter25"},
    }
    expanded: Set[str] = set()
    for term in pollutant_set:
        normalized = _normalize_pollutant_text(term)
        if normalized in aliases:
            expanded.update({_normalize_pollutant_text(t) for t in aliases[normalized]})
        else:
            expanded.add(normalized)
    return expanded


def _normalize_ref(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return None
        if "://" in trimmed:
            trimmed = trimmed.rstrip("/")
            return trimmed.rsplit("/", 1)[-1] or trimmed
        return trimmed
    return None


def _extract_ref_id(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, dict):
        for key in ("id", "identifier", "href", "@id", "value"):
            ref = _normalize_ref(value.get(key))
            if ref:
                return ref
        return None
    return _normalize_ref(value)


def _coerce_feature_payload(value: Any) -> Optional[Dict[str, Any]]:
    if not value:
        return None
    if isinstance(value, list):
        for item in value:
            payload = _coerce_feature_payload(item)
            if payload:
                return payload
        return None
    if isinstance(value, dict):
        return value
    return {"id": value}


def _extract_feature_payload(ts: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    containers: List[Dict[str, Any]] = [ts]
    for key in ("properties", "extensions", "metadata", "info"):
        nested = ts.get(key)
        if isinstance(nested, dict):
            containers.append(nested)
    for container in containers:
        for key in (
            "feature",
            "featureOfInterest",
            "feature_of_interest",
            "featuresOfInterest",
            "features_of_interest",
            "foi",
            "samplingFeature",
            "samplingFeatures",
        ):
            payload = _coerce_feature_payload(container.get(key))
            if payload:
                return payload
    return None


def _extract_station_ref(ts: Dict[str, Any]) -> Optional[str]:
    for key in ("station", "station_id", "stationId", "station_ref", "stationRef"):
        ref = _extract_ref_id(ts.get(key))
        if ref:
            return ref
    feature_payload = _extract_feature_payload(ts)
    if feature_payload:
        ref = _extract_ref_id(feature_payload)
        if ref:
            return ref
    return None


def _timeseries_feature_items(series: Sequence[Dict[str, Any]]) -> Iterable[Dict[str, Any]]:
    for ts in series:
        payload = _extract_feature_payload(ts)
        if payload:
            yield payload


def _matches_pollutant(ts: Dict[str, Any], pollutant_set: Set[str]) -> bool:
    phenomenon = ts.get("phenomenon") or {}
    label = phenomenon.get("label") or ""
    phen_id = phenomenon.get("id") or ""
    fallback_label = ts.get("label") or ts.get("id") or ""
    if not label and not phen_id:
        text = _normalize_pollutant_text(str(fallback_label))
    else:
        text = _normalize_pollutant_text(f"{label} {phen_id} {fallback_label}")
    terms = _expand_pollutant_terms(pollutant_set)
    return any(term in text for term in terms)


def _sample_phenomena(series: Sequence[Dict[str, Any]], limit: int = 5) -> List[str]:
    samples: List[str] = []
    for ts in series:
        phenomenon = ts.get("phenomenon") or {}
        label = phenomenon.get("label")
        phen_id = phenomenon.get("id")
        entry = label or phen_id or ts.get("label") or ts.get("id")
        if entry:
            samples.append(str(entry))
        if len(samples) >= limit:
            break
    return samples


def _summarize_timeseries(ts: Dict[str, Any]) -> Dict[str, Any]:
    phenomenon = ts.get("phenomenon") if isinstance(ts.get("phenomenon"), dict) else None
    category = ts.get("category") if isinstance(ts.get("category"), dict) else None
    offering = ts.get("offering") if isinstance(ts.get("offering"), dict) else None
    procedure = ts.get("procedure") if isinstance(ts.get("procedure"), dict) else None
    return {
        "id": ts.get("id"),
        "label": ts.get("label"),
        "phenomenon": {
            "id": phenomenon.get("id") if phenomenon else None,
            "label": phenomenon.get("label") if phenomenon else None,
            "notation": phenomenon.get("notation") if phenomenon else None,
            "eionet_uri": phenomenon.get("eionet_uri") if phenomenon else None,
        },
        "category": {
            "id": category.get("id") if category else None,
            "label": category.get("label") if category else None,
        },
        "offering": {
            "id": offering.get("id") if offering else None,
            "label": offering.get("label") if offering else None,
        },
        "procedure": {
            "id": procedure.get("id") if procedure else None,
            "label": procedure.get("label") if procedure else None,
        },
        "uom": ts.get("uom"),
    }


class EionetPollutantResolver:
    def __init__(self, timeout: int = 20, retries: int = 2) -> None:
        self.timeout = timeout
        self.retries = retries
        self.session = requests.Session()
        self.cache: Dict[str, Optional[str]] = {}

    def resolve(self, uri: str) -> Dict[str, Optional[str]]:
        if uri in self.cache and f"{uri}#notation" in self.cache:
            return {
                "label": self.cache[uri],
                "notation": self.cache.get(f"{uri}#notation"),
            }
        label = None
        notation = None
        for attempt in range(1, self.retries + 1):
            try:
                payload = self._fetch_json(uri)
                notation = (
                    _find_json_value(payload, "notation")
                    or _find_json_value(payload, "skos:notation")
                    or _find_json_value(payload, "http://www.w3.org/2004/02/skos/core#notation")
                )
                label = _extract_eionet_label(payload)
                if not notation or not label:
                    html = self._fetch_html(uri)
                    if html:
                        if not label:
                            label = _extract_eionet_label_from_html(html)
                        if not notation:
                            notation = _extract_eionet_notation_from_html(html)
                break
            except requests.RequestException:
                if attempt == self.retries:
                    break
        self.cache[uri] = label
        self.cache[f"{uri}#notation"] = notation
        if notation is None:
            LOG.info("Eionet notation missing for uri=%s label=%s", uri, label)
        return {"label": label, "notation": notation}

    def _fetch_json(self, uri: str) -> Any:
        headers = {"Accept": "application/ld+json, application/json"}
        urls = [
            uri,
            f"{uri}?format=application/ld+json",
            f"{uri}?format=application/json",
            f"{uri}.jsonld",
            f"{uri}.json",
        ]
        for url in urls:
            resp = self.session.get(url, headers=headers, timeout=self.timeout)
            if not resp.ok:
                continue
            try:
                return resp.json()
            except ValueError:
                continue
        return {}

    def _fetch_html(self, uri: str) -> Optional[str]:
        resp = self.session.get(uri, headers={"Accept": "text/html"}, timeout=self.timeout)
        if resp.ok:
            return resp.text
        resp = self.session.get(uri, timeout=self.timeout)
        if resp.ok:
            return resp.text
        return None


def _extract_pollutant_uri(ts: Dict[str, Any]) -> Optional[str]:
    candidates = []
    phenomenon = ts.get("phenomenon")
    if isinstance(phenomenon, dict):
        candidates.extend(
            [phenomenon.get("id"), phenomenon.get("eionet_uri"), phenomenon.get("label")]
        )
    candidates.extend([ts.get("label"), ts.get("id")])
    for candidate in candidates:
        if not candidate:
            continue
        match = EIONET_POLLUTANT_RE.search(str(candidate))
        if match:
            return match.group(0)
    return None


def _ensure_phenomenon(ts: Dict[str, Any], resolver: EionetPollutantResolver) -> None:
    phenomenon = ts.get("phenomenon") if isinstance(ts.get("phenomenon"), dict) else {}
    if not isinstance(phenomenon, dict):
        phenomenon = {}
    phen_id = phenomenon.get("id")
    phen_label = phenomenon.get("label")
    phen_uri = phenomenon.get("eionet_uri")
    phen_notation = phenomenon.get("notation")
    uri = _extract_pollutant_uri(ts)
    if not phen_id and uri:
        phenomenon["id"] = uri
    if uri and not phen_uri:
        phenomenon["eionet_uri"] = uri
    if uri and (not phen_label or not phen_notation):
        resolved = resolver.resolve(uri)
        if not phen_notation and resolved.get("notation"):
            phenomenon["notation"] = resolved["notation"]
        if not phen_label and resolved.get("label"):
            phenomenon["label"] = resolved["label"]
    if not phenomenon.get("label"):
        fallback = phenomenon.get("notation") or phenomenon.get("id") or phenomenon.get("eionet_uri")
        if fallback:
            phenomenon["label"] = fallback
    if phenomenon:
        ts["phenomenon"] = phenomenon


def _extract_eionet_label(payload: Any) -> Optional[str]:
    return (
        _find_json_value(payload, "prefLabel")
        or _find_json_value(payload, "skos:prefLabel")
        or _find_json_value(payload, "http://www.w3.org/2004/02/skos/core#prefLabel")
    )


def _extract_eionet_label_from_html(html: str) -> Optional[str]:
    return _extract_html_table_value(html, "Preferred label")


def _extract_eionet_notation_from_html(html: str) -> Optional[str]:
    return _extract_html_table_value(html, "Notation")


def _extract_html_table_value(html: str, label: str) -> Optional[str]:
    label_norm = _normalize_html_label(label)
    dt_match = re.search(
        rf"<dt[^>]*>\\s*{re.escape(label)}\\s*</dt>\\s*<dd[^>]*>(.*?)</dd>",
        html,
        re.IGNORECASE | re.DOTALL,
    )
    if dt_match:
        value = _strip_html(dt_match.group(1))
        if value:
            return value
    for row in re.findall(r"<tr[^>]*>.*?</tr>", html, re.IGNORECASE | re.DOTALL):
        if label_norm not in _normalize_html_label(row):
            continue
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.IGNORECASE | re.DOTALL)
        texts = [_strip_html(cell) for cell in cells]
        for idx, text in enumerate(texts):
            text_norm = _normalize_html_label(text)
            if label_norm in text_norm:
                if idx + 1 < len(texts):
                    return texts[idx + 1] or None
        if len(texts) >= 2:
            return texts[1] or None
    return None


def _strip_html(value: str) -> str:
    cleaned = re.sub(r"<[^>]+>", " ", value)
    cleaned = html.unescape(cleaned)
    cleaned = re.sub(r"\\s+", " ", cleaned)
    return cleaned.strip()


def _normalize_html_label(value: str) -> str:
    return re.sub(r"\\s+", " ", value).strip().rstrip(":").lower()


def _find_json_value(payload: Any, key: str) -> Optional[str]:
    if isinstance(payload, dict):
        if key in payload:
            return _coerce_json_value(payload.get(key))
        for value in payload.values():
            found = _find_json_value(value, key)
            if found:
                return found
    elif isinstance(payload, list):
        for item in payload:
            found = _find_json_value(item, key)
            if found:
                return found
    return None


def _coerce_json_value(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, dict):
        if "@value" in value:
            return _coerce_json_value(value.get("@value"))
        if "en" in value:
            return _coerce_json_value(value.get("en"))
    if isinstance(value, list):
        for item in value:
            coerced = _coerce_json_value(item)
            if coerced:
                return coerced
    return None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest UK-AIR SOS data into Supabase.")
    parser.add_argument("--discover", action="store_true", help="Discover services, stations, timeseries.")
    parser.add_argument("--backfill-2025", action="store_true", help="Backfill 2025 data.")
    parser.add_argument("--backfill-year", type=int, help="Backfill a specific year (overrides --backfill-2025).")
    parser.add_argument("--refresh-recent", action="store_true", help="Refresh last N hours.")
    parser.add_argument("--hours", type=int, default=6, help="Window size in hours for --refresh-recent.")
    parser.add_argument("--chunk-days", type=int, default=31, help="Chunk size for backfill requests.")
    parser.add_argument(
        "--bbox",
        default="uk",
        help="Bounding box west,south,east,north (default: uk). Use 'none' to disable.",
    )
    parser.add_argument("--no-bbox", action="store_true", help="Disable bbox filtering.")
    parser.add_argument(
        "--strict-bbox",
        action="store_true",
        help="Exclude stations with missing or invalid coordinates.",
    )
    parser.add_argument("--region", help="Region name to filter (optional).")
    parser.add_argument("--station-like", help="Filter stations by label substring (optional).")
    parser.add_argument(
        "--station-type",
        help="Comma-separated station types to include (e.g., AURN).",
    )
    parser.add_argument(
        "--pollutants",
        default=",".join(sorted(DEFAULT_POLLUTANTS)),
        help="Comma-separated pollutant ids/labels to include (default: common pollutants). Use 'all' for no filter.",
    )
    parser.add_argument("--all-pollutants", action="store_true", help="Disable pollutant filtering.")
    parser.add_argument(
        "--service-ref",
        "--service-id",
        dest="service_ref",
        help="Explicit service ref to use (optional).",
    )
    parser.add_argument("--service-label", help="Match service label by substring (optional).")
    parser.add_argument(
        "--sample-timeseries",
        type=int,
        default=0,
        help="Log a small summary of the first N timeseries objects (default: 0).",
    )
    parser.add_argument(
        "--raw-dropbox",
        action="store_true",
        help="Upload raw SOS payloads to Dropbox (testing only; gated by env allowlist).",
    )
    parser.add_argument(
        "--raw-dropbox-folder",
        help="Dropbox folder path for raw payloads (optional).",
    )
    parser.add_argument(
        "--log-level",
        default=DEFAULT_LOG_LEVEL,
        help="Logging level (DEBUG, INFO, WARNING, ERROR).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    _configure_logging(args.log_level, DEFAULT_FILE_LOG_LEVEL)
    raw_session = _prepare_raw_dropbox_session(args)
    client = UkAirClient(raw_recorder=raw_session.recorder if raw_session else None)
    writer = SupabaseWriter()
    error_logger = ErrorLogger(writer.client)
    ingestor = UkAirIngestor(client, writer, error_logger)
    stations_count = 0
    errors = 0

    try:
        bbox = None if args.no_bbox else _parse_bbox_arg(args.bbox)
        region = args.region
        station_like = args.station_like
        station_types = _parse_csv_arg(args.station_type)
        if station_types:
            station_types = [st_type.lower() for st_type in station_types]
        allow_missing_coords = not args.strict_bbox
        pollutants = None
        if not args.all_pollutants:
            pollutants = _parse_csv_arg(args.pollutants)
            if pollutants and len(pollutants) == 1 and pollutants[0].lower() in {"all", "*"}:
                pollutants = None

        connector = ingestor.discover_service(args.service_ref, args.service_label)
        settings = writer.get_connector_settings(connector.id)
        batch_size = settings.get("poll_timeseries_batch_size")
        bbox_supported = settings.get("stations_bbox_supported")
        station_filter_supported = settings.get("timeseries_station_filter_supported")
        if batch_size is not None:
            LOG.info("Using timeseries batch size from connectors: %s", batch_size)
        if bbox_supported is False:
            bbox = None
            LOG.info(
                "Skipping bbox for connector id %s (stations_bbox_supported=false)",
                connector.id,
            )
        if station_filter_supported is False:
            LOG.info(
                "Skipping station filter for connector id %s (timeseries_station_filter_supported=false)",
                connector.id,
            )
        LOG.info(
            "Using connector id: %s service_ref=%s (bbox=%s region=%s station_like=%s station_types=%s pollutants=%s)",
            connector.id,
            connector.service_ref,
            bbox,
            region,
            station_like,
            station_types,
            pollutants or "all",
        )

        if raw_session:
            raw_session.recorder.record_event(
                "context",
                {
                    "connector_id": connector.id,
                    "service_ref": connector.service_ref,
                    "service_label": connector.label,
                    "bbox": bbox,
                    "region": region,
                    "station_like": station_like,
                    "station_types": station_types,
                    "pollutants": pollutants or "all",
                    "refresh_recent": args.refresh_recent,
                    "backfill_year": args.backfill_year or (2025 if args.backfill_2025 else None),
                },
            )

        stations = ingestor.discover_stations(
            connector,
            bbox,
            region,
            station_types,
            allow_missing_coords,
            station_like,
        )
        stations_count = len(stations)
        station_refs = [
            stn.get("id") or (stn.get("properties", {}) or {}).get("id")
            for stn in stations
            if stn.get("id") or (stn.get("properties", {}) or {}).get("id")
        ]
        if not station_refs:
            LOG.debug("No stations discovered for the given filters.")
        series = ingestor.discover_timeseries(
            connector,
            None if station_filter_supported is False else station_refs,
            pollutants,
            batch_size,
            args.sample_timeseries,
        )

        backfill_year = args.backfill_year or (2025 if args.backfill_2025 else None)
        if backfill_year:
            errors += ingestor.backfill_year(
                series,
                backfill_year,
                chunk_days=args.chunk_days,
                connector_id=connector.id,
            )
        if args.refresh_recent:
            errors += ingestor.refresh_recent(series, hours=args.hours, connector_id=connector.id)
        if not any([args.discover, backfill_year, args.refresh_recent]):
            LOG.debug("No action flags set; use --discover, --backfill-year, or --refresh-recent.")
    except Exception as exc:
        errors += 1
        LOG.warning("Unhandled ingest error: %s", exc)
        error_logger.log_error(
            source="ingest",
            severity="error",
            message="Unhandled ingest error.",
            context={"station_like": args.station_like, "region": args.region},
            exc=exc,
        )
    finally:
        if raw_session:
            raw_session.finalize()
        print(f"Stations collected: {stations_count}")
        print(f"Errors: {errors}")


if __name__ == "__main__":
    main()
