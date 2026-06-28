#!/usr/bin/env python3
import json
import os
import re
import subprocess
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

PORT = int(os.getenv("PORT", "8000"))
SCRIPT = os.getenv("BLONDON_NODES_INGEST_SCRIPT_PATH", "/app/scripts/blondon_nodes/blondon_nodes_ingest.py")
ACCEPTED_KEYS = {
    "start_time", "end_time", "site_code", "species",
    "max_stations", "max_api_calls", "dry_run",
}
SITE_CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
ALLOWED_SPECIES = {"PM25", "NO2", "PM25Index", "NO2Index"}
MAX_REQUEST_BYTES = 4096


class RequestValidationError(ValueError):
    pass


def _validate_timestamp(key: str, value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 40:
        raise RequestValidationError(f"{key} must be a non-empty ISO 8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise RequestValidationError(f"{key} must be a valid ISO 8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise RequestValidationError(f"{key} must include a timezone")
    return value


def validated_cli_args(payload: Any) -> list[str]:
    if not isinstance(payload, dict):
        raise RequestValidationError("request body must be a JSON object")
    unknown = sorted(set(payload) - ACCEPTED_KEYS)
    if unknown:
        raise RequestValidationError(f"unsupported request key: {unknown[0]}")

    args: list[str] = ["python3", SCRIPT]
    for key, flag in (("start_time", "--start-time"), ("end_time", "--end-time")):
        if key in payload:
            args.extend((flag, _validate_timestamp(key, payload[key])))

    if "site_code" in payload:
        value = payload["site_code"]
        if not isinstance(value, str) or not SITE_CODE_RE.fullmatch(value):
            raise RequestValidationError(
                "site_code must be 1-64 letters, numbers, dots, underscores, or hyphens"
            )
        args.extend(("--site-code", value))

    if "species" in payload:
        value = payload["species"]
        if not isinstance(value, str) or not value or len(value) > 64:
            raise RequestValidationError("species must be a non-empty comma-separated string")
        species = value.split(",")
        if any(item not in ALLOWED_SPECIES for item in species) or len(set(species)) != len(species):
            raise RequestValidationError(
                "species may contain each of PM25, NO2, PM25Index, and NO2Index once"
            )
        args.extend(("--species", value))

    for key, flag, maximum in (
        ("max_stations", "--max-stations", 10000),
        ("max_api_calls", "--max-api-calls", 100000),
    ):
        if key in payload:
            value = payload[key]
            if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
                raise RequestValidationError(f"{key} must be an integer from 1 to {maximum}")
            args.extend((flag, str(value)))

    if "dry_run" in payload:
        if not isinstance(payload["dry_run"], bool):
            raise RequestValidationError("dry_run must be a boolean")
        if payload["dry_run"]:
            args.append("--dry-run")
    return args

class Handler(BaseHTTPRequestHandler):
    def _json_response(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")

    def do_POST(self):
        try:
            length = int(self.headers.get("content-length") or 0)
            if length < 0 or length > MAX_REQUEST_BYTES:
                raise RequestValidationError(f"request body must not exceed {MAX_REQUEST_BYTES} bytes")
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            payload = json.loads(raw or "{}")
            args = validated_cli_args(payload)
        except (UnicodeDecodeError, json.JSONDecodeError, RequestValidationError, ValueError) as exc:
            self._json_response(400, {"ok": False, "error": str(exc)})
            return

        proc = subprocess.run(args, text=True, capture_output=True, timeout=int(os.getenv("BLONDON_NODES_MAX_RUNTIME_SECONDS", "840")))
        body = {"ok": proc.returncode == 0, "returncode": proc.returncode, "stdout": proc.stdout[-4000:], "stderr": proc.stderr[-4000:]}
        self._json_response(200 if proc.returncode == 0 else 500, body)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
