#!/usr/bin/env python3
import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.getenv("PORT", "8000"))
SCRIPT = os.getenv("BLONDON_NODES_INGEST_SCRIPT_PATH", "/app/scripts/blondon_nodes/blondon_nodes_ingest.py")

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length).decode() if length else "{}"
        try:
            payload = json.loads(raw or "{}")
        except json.JSONDecodeError:
            payload = {}
        args = ["python3", SCRIPT]
        mapping = {
            "start_time": "--start-time", "end_time": "--end-time", "site_code": "--site-code",
            "species": "--species", "max_stations": "--max-stations", "max_api_calls": "--max-api-calls",
        }
        for key, flag in mapping.items():
            value = payload.get(key)
            if value not in (None, ""):
                args += [flag, str(value)]
        if payload.get("dry_run"):
            args.append("--dry-run")
        proc = subprocess.run(args, text=True, capture_output=True, timeout=int(os.getenv("BLONDON_NODES_MAX_RUNTIME_SECONDS", "840")))
        body = {"ok": proc.returncode == 0, "returncode": proc.returncode, "stdout": proc.stdout[-4000:], "stderr": proc.stderr[-4000:]}
        encoded = json.dumps(body).encode()
        self.send_response(200 if proc.returncode == 0 else 500)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers(); self.wfile.write(encoded)

ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
