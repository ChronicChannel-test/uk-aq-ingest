#!/usr/bin/env python3
"""Export open CodeQL code-scanning alerts and their instances."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional
from urllib.parse import urlencode
from urllib.request import Request, urlopen

API_ROOT = "https://api.github.com"
DEFAULT_REPO = "ChronicChannel-test/uk-aq-ingest"


def parse_args() -> argparse.Namespace:
    today = dt.date.today().isoformat()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=DEFAULT_REPO, help="GitHub repo in OWNER/REPO format")
    parser.add_argument("--state", default="open", help="Alert state filter (default: open)")
    parser.add_argument("--per-page", type=int, default=100, help="Results per page (max 100)")
    parser.add_argument(
        "--outdir",
        default=f".codeql/exports/{today}",
        help="Output directory for alerts.json and instances",
    )
    return parser.parse_args()


def resolve_token() -> str:
    env_token = os.getenv("GITHUB_TOKEN")
    if env_token:
        return env_token

    try:
        proc = subprocess.run(["gh", "auth", "token"], check=True, capture_output=True, text=True)
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        raise RuntimeError("No GitHub token found. Set GITHUB_TOKEN or login with gh auth.") from exc

    token = proc.stdout.strip()
    if not token:
        raise RuntimeError("gh auth token returned empty output.")
    return token


def parse_next_link(link_header: str | None) -> Optional[str]:
    if not link_header:
        return None
    for part in [p.strip() for p in link_header.split(",")]:
        if 'rel="next"' in part:
            start = part.find("<")
            end = part.find(">")
            if start != -1 and end != -1 and end > start:
                return part[start + 1 : end]
    return None


def api_get(url: str, token: str, params: Dict[str, Any] | None = None) -> tuple[Any, Dict[str, str]]:
    if params:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}{urlencode(params)}"

    req = Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "uk-aq-codeql-export-script",
        },
    )
    with urlopen(req, timeout=30) as response:
        data = json.loads(response.read().decode("utf-8"))
        headers = {k: v for k, v in response.headers.items()}
        return data, headers


def paged_get(token: str, url: str, params: Dict[str, Any]) -> Iterator[Dict[str, Any]]:
    next_url: Optional[str] = url
    next_params: Optional[Dict[str, Any]] = params.copy()

    while next_url:
        payload, headers = api_get(next_url, token, next_params)
        if not isinstance(payload, list):
            raise RuntimeError(f"Expected list payload from {next_url}, got {type(payload)!r}")

        for item in payload:
            if isinstance(item, dict):
                yield item

        next_url = parse_next_link(headers.get("Link"))
        next_params = None


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def fetch_alert_instances(token: str, owner: str, repo: str, alert_number: int, per_page: int) -> List[Dict[str, Any]]:
    url = f"{API_ROOT}/repos/{owner}/{repo}/code-scanning/alerts/{alert_number}/instances"
    params = {"per_page": per_page}
    return list(paged_get(token, url, params))


def main() -> None:
    args = parse_args()
    owner, repo = args.repo.split("/", maxsplit=1)
    token = resolve_token()

    outdir = Path(args.outdir)
    instances_dir = outdir / "instances"
    ensure_dir(instances_dir)

    alerts_url = f"{API_ROOT}/repos/{owner}/{repo}/code-scanning/alerts"
    alerts_params = {
        "state": args.state,
        "tool_name": "CodeQL",
        "per_page": min(max(args.per_page, 1), 100),
    }

    alerts: List[Dict[str, Any]] = list(paged_get(token, alerts_url, alerts_params))
    write_json(outdir / "alerts.json", alerts)

    instance_count = 0
    for alert in alerts:
        alert_number = alert.get("number")
        if not isinstance(alert_number, int):
            continue
        instances = fetch_alert_instances(token, owner, repo, alert_number, args.per_page)
        write_json(instances_dir / f"{alert_number}.json", instances)
        instance_count += len(instances)

    print(
        f"Export complete: {len(alerts)} alerts written to {outdir / 'alerts.json'}; "
        f"{instance_count} instances written under {instances_dir}."
    )


if __name__ == "__main__":
    main()
