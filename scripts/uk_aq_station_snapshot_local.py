#!/usr/bin/env python3
# trigger deploy 2026-02-14
"""Run a local Station Snapshot dashboard that calls the uk_aq_station_snapshot edge function."""

from __future__ import annotations

import argparse
import base64
import json
import os
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import parse_qs, urlparse


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


def _upsert_env_file(path: Path, updates: dict[str, str]) -> None:
    if path.exists():
        lines = path.read_text(encoding="utf-8").splitlines()
    else:
        lines = []
    found = set()
    new_lines: list[str] = []
    for line in lines:
        replaced = False
        for key, value in updates.items():
            if line.startswith(f"{key}="):
                new_lines.append(f"{key}={value}")
                found.add(key)
                replaced = True
                break
        if not replaced:
            new_lines.append(line)
    for key, value in updates.items():
        if key not in found:
            new_lines.append(f"{key}={value}")
    path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")


def _default_edge_url() -> str:
    explicit = (
        os.getenv("UK_AQ_STATION_SNAPSHOT_EDGE_URL")
        or os.getenv("STATION_SNAPSHOT_EDGE_URL")
        or ""
    ).strip()
    if explicit:
        return explicit

    supabase_url = (
        os.getenv("SUPABASE_URL")
        or os.getenv("SB_SUPABASE_URL")
        or ""
    ).strip().rstrip("/")
    if not supabase_url:
        return ""
    return f"{supabase_url}/functions/v1/uk_aq_station_snapshot"


def _env_publishable_key() -> str:
    return (
        os.getenv("SB_PUBLISHABLE_DEFAULT_KEY")
        or os.getenv("SB_ANON_JWT")
        or ""
    ).strip()


def _jwt_expiry_epoch(token: str) -> int | None:
    parts = token.split(".")
    if len(parts) < 2:
        return None
    payload = parts[1]
    payload += "=" * ((4 - len(payload) % 4) % 4)
    try:
        decoded = base64.urlsafe_b64decode(payload.encode("ascii")).decode("utf-8")
        data = json.loads(decoded)
    except Exception:
        return None
    exp = data.get("exp")
    if isinstance(exp, (int, float)):
        return int(exp)
    return None


def _token_is_fresh(token: str, skew_seconds: int = 60) -> bool:
    if not token:
        return False
    exp = _jwt_expiry_epoch(token)
    if exp is None:
        return True
    return exp > int(time.time()) + max(0, skew_seconds)


def _refresh_access_token(auth_state: dict[str, str]) -> tuple[str | None, str | None]:
    supabase_url = (auth_state.get("supabase_url") or "").strip().rstrip("/")
    publishable_key = (auth_state.get("publishable_key") or "").strip()
    refresh_token = (auth_state.get("refresh_token") or "").strip()
    if not (supabase_url and publishable_key and refresh_token):
        return None, "Refresh token flow is not configured."

    request_body = json.dumps({"refresh_token": refresh_token}).encode("utf-8")
    request = urllib_request.Request(
        f"{supabase_url}/auth/v1/token?grant_type=refresh_token",
        data=request_body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "apikey": publishable_key,
        },
    )
    try:
        with urllib_request.urlopen(request, timeout=12) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib_error.HTTPError as exc:
        message = exc.reason
        try:
            body = exc.read().decode("utf-8")
            parsed = json.loads(body)
            message = parsed.get("msg") or parsed.get("message") or message
        except Exception:
            pass
        return None, f"Token refresh failed ({exc.code}): {message}"
    except Exception as exc:
        return None, f"Token refresh failed: {exc}"

    access_token = str(payload.get("access_token") or "").strip()
    next_refresh_token = str(payload.get("refresh_token") or "").strip()
    if not access_token:
        return None, "Token refresh returned no access_token."
    auth_state["access_token"] = access_token
    if next_refresh_token:
        auth_state["refresh_token"] = next_refresh_token
        env_path = (auth_state.get("env_path") or "").strip()
        if env_path:
            try:
                _upsert_env_file(
                    Path(env_path),
                    {
                        "UK_AQ_DEV_REFRESH_TOKEN": next_refresh_token,
                        "UK_AQ_DEV_JWT": access_token,
                    },
                )
            except OSError:
                pass
    return access_token, None


def _ensure_access_token(
    auth_state: dict[str, str], auth_lock: threading.Lock, force_refresh: bool = False
) -> tuple[str | None, str | None]:
    with auth_lock:
        token = (auth_state.get("access_token") or "").strip()
        if token and not force_refresh and _token_is_fresh(token):
            return token, None

        refreshed_token, refresh_error = _refresh_access_token(auth_state)
        if refreshed_token:
            return refreshed_token, None

        if token and _token_is_fresh(token, skew_seconds=0):
            return token, None
        return None, refresh_error or "No valid access token available."


class StationSnapshotHandler(BaseHTTPRequestHandler):
    server_version = "uk-aq-station-snapshot-local/1.1"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            self._serve_html()
            return
        if parsed.path == "/api/config":
            self._serve_config()
            return
        if parsed.path == "/api/token":
            self._serve_token(parsed)
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

    def _serve_config(self) -> None:
        access_token, _token_error = _ensure_access_token(
            self.server.auth_state,
            self.server.auth_lock,
            force_refresh=False,
        )
        payload = json.dumps(
            {
                "edge_url": self.server.edge_url,
                "default_station_id": self.server.default_station_id,
                "default_jwt": access_token or "",
            },
            indent=2,
        )
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))

    def _serve_token(self, parsed) -> None:
        query = parse_qs(parsed.query or "")
        force_refresh = (query.get("force_refresh", ["0"])[0] or "").strip() in (
            "1",
            "true",
            "yes",
        )
        access_token, token_error = _ensure_access_token(
            self.server.auth_state,
            self.server.auth_lock,
            force_refresh=force_refresh,
        )
        if not access_token:
            payload = json.dumps({"error": token_error or "No valid token available."}, indent=2)
            self.send_response(HTTPStatus.UNAUTHORIZED)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))
            return

        payload = json.dumps({"access_token": access_token}, indent=2)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))


def parse_args() -> argparse.Namespace:
    host_default = os.getenv("HOST", "127.0.0.1")
    try:
        port_default = int(os.getenv("PORT", "8046"))
    except ValueError:
        port_default = 8046
    dev_env_default = os.getenv("UK_AQ_DEV_ENV_FILE", ".env.supabase")
    parser = argparse.ArgumentParser(description="Run a local UK AQ Station Snapshot dashboard.")
    parser.add_argument("--host", default=host_default, help="Bind host (default: HOST or 127.0.0.1).")
    parser.add_argument("--port", type=int, default=port_default, help="Bind port (default: PORT or 8046).")
    parser.add_argument(
        "--html",
        default="data/uk_aq_station_snapshot/uk_aq_station_snapshot.html",
        help="Path to HTML file.",
    )
    parser.add_argument(
        "--edge-url",
        default="",
        help=(
            "Station snapshot edge URL. Defaults to UK_AQ_STATION_SNAPSHOT_EDGE_URL "
            "or <SUPABASE_URL>/functions/v1/uk_aq_station_snapshot."
        ),
    )
    parser.add_argument(
        "--dev-jwt",
        default=os.getenv("UK_AQ_DEV_JWT", ""),
        help="Initial auth JWT for edge calls (defaults to UK_AQ_DEV_JWT).",
    )
    parser.add_argument(
        "--dev-refresh-token",
        default=os.getenv("UK_AQ_DEV_REFRESH_TOKEN", ""),
        help=(
            "Refresh token for auto-refreshing UK_AQ_DEV_JWT. "
            "Defaults to UK_AQ_DEV_REFRESH_TOKEN."
        ),
    )
    parser.add_argument(
        "--dev-env-file",
        default=dev_env_default,
        help=(
            "Env file to update with rotated UK_AQ_DEV_REFRESH_TOKEN (default: "
            "UK_AQ_DEV_ENV_FILE or .env.supabase)."
        ),
    )
    return parser.parse_args()


def main() -> None:
    _load_env(Path(".env"))
    _load_env(Path(".env.supabase"))
    args = parse_args()

    edge_url = (args.edge_url or _default_edge_url()).strip()
    if not edge_url:
        raise SystemExit(
            "Station snapshot edge URL is required. "
            "Set --edge-url or UK_AQ_STATION_SNAPSHOT_EDGE_URL (or SUPABASE_URL)."
        )

    html_path = Path(args.html)
    if not html_path.exists():
        raise SystemExit(f"HTML file not found: {html_path}")
    dev_jwt = (args.dev_jwt or "").strip()
    dev_refresh_token = (args.dev_refresh_token or "").strip()
    dev_env_file = (args.dev_env_file or "").strip()
    supabase_url = (os.getenv("SUPABASE_URL") or os.getenv("SB_SUPABASE_URL") or "").strip()
    publishable_key = _env_publishable_key()

    if not dev_jwt and not dev_refresh_token:
        raise SystemExit(
            "UK_AQ_DEV_JWT or UK_AQ_DEV_REFRESH_TOKEN is required for this dashboard."
        )
    if dev_refresh_token and (not supabase_url or not publishable_key):
        raise SystemExit(
            "Auto-refresh requires SUPABASE_URL (or SB_SUPABASE_URL) and "
            "SB_PUBLISHABLE_DEFAULT_KEY (or SB_ANON_JWT)."
        )

    server = ThreadingHTTPServer((args.host, args.port), StationSnapshotHandler)
    server.html_path = html_path
    server.edge_url = edge_url
    server.default_station_id = (os.getenv("CLEANAIRSURB_ST_ID") or "").strip()
    server.auth_lock = threading.Lock()
    server.auth_state = {
        "access_token": dev_jwt,
        "refresh_token": dev_refresh_token,
        "supabase_url": supabase_url,
        "publishable_key": publishable_key,
        "env_path": dev_env_file,
    }

    print(f"UK AQ station snapshot dashboard running at http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
