#!/usr/bin/env python3
"""Run a local Station Snapshot dashboard that calls the uk_aq_station_snapshot edge function."""

from __future__ import annotations

import argparse
import json
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


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


class StationSnapshotHandler(BaseHTTPRequestHandler):
    server_version = "uk-aq-station-snapshot-local/1.0"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            self._serve_html()
            return
        if parsed.path == "/api/config":
            self._serve_config()
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
        payload = json.dumps(
            {
                "edge_url": self.server.edge_url,
                "default_jwt": self.server.default_jwt,
            },
            indent=2,
        )
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
        help="Optional default JWT to pre-fill in the local page.",
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

    server = ThreadingHTTPServer((args.host, args.port), StationSnapshotHandler)
    server.html_path = html_path
    server.edge_url = edge_url
    server.default_jwt = (args.dev_jwt or "").strip()

    print(f"UK AQ station snapshot dashboard running at http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
