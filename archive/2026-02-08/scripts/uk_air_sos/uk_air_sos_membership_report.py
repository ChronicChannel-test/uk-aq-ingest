#!/usr/bin/env python3
"""
Generate a detailed SOS membership backfill report as CSV.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple
from urllib.parse import urlencode
from urllib.request import Request, urlopen

POLLUTANT_PARENS_RE = re.compile(r"\s*\([^)]*\)")
DEFAULT_CONNECTOR_CODE = "uk_air_sos"


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


def _fetch_json(base_url: str, headers: Dict[str, str], table: str, params: Dict[str, str]) -> List[Dict[str, Any]]:
    query = urlencode(params, safe=",.*()")
    req = Request(f"{base_url}/{table}?{query}", headers=headers, method="GET")
    with urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data if isinstance(data, list) else []


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
        batch = _fetch_json(base_url, headers, table, batch_params)
        rows.extend(batch)
        if len(batch) < limit:
            break
        offset += limit
    return rows


def _chunked(values: Sequence[str], size: int) -> Iterable[List[str]]:
    for idx in range(0, len(values), size):
        yield list(values[idx : idx + size])


def _normalize_pollutant_key(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    cleaned = re.sub(r"[^a-z0-9]+", "", str(value).lower()).strip()
    return cleaned or None


def _pollutant_keys_from_text(value: Optional[str]) -> List[str]:
    if not value:
        return []
    raw = str(value).strip()
    if not raw:
        return []
    stripped = POLLUTANT_PARENS_RE.sub("", raw).strip()
    keys = {_normalize_pollutant_key(raw), _normalize_pollutant_key(stripped)}
    return [key for key in keys if key]


def _pollutant_keys_from_phenomenon(row: Dict[str, Any]) -> List[str]:
    keys: List[str] = []
    for field in ("pollutant_label", "label", "notation"):
        keys.extend(_pollutant_keys_from_text(row.get(field)))
    return keys


def _network_allows_pollutants(
    network_ref: str,
    pollutant_keys: Set[str],
    rules: Dict[str, List[Tuple[str, str]]],
) -> bool:
    if not network_ref or not pollutant_keys:
        return False
    matchers = rules.get(network_ref, [])
    if not matchers:
        return False
    for match_type, value in matchers:
        if not value:
            continue
        if match_type == "exact":
            if value in pollutant_keys:
                return True
            continue
        if any(value in key for key in pollutant_keys):
            return True
    return False


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
        return None, None
    return None, None


def _join(values: Iterable[str]) -> str:
    return "; ".join(str(val) for val in values if val)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a detailed SOS membership backfill report as CSV.",
    )
    parser.add_argument(
        "--output",
        help="Output CSV path (default: network_info/UK-Air-SOS/uk_air_sos_membership_backfill_report_<timestamp>.csv).",
    )
    parser.add_argument(
        "--snapshot-at",
        help="Snapshot timestamp for uk_air_sos_site_register (default: latest).",
    )
    parser.add_argument(
        "--connector-code",
        default=DEFAULT_CONNECTOR_CODE,
        help="Connector code to report on (default: uk_air_sos).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    _load_env(Path(".env"))

    supabase_url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    core_schema = os.getenv("UK_AQ_CORE_SCHEMA", "uk_aq_core")
    if not supabase_url or not supabase_key:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")

    base_url = f"{supabase_url}/rest/v1"
    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
        "Accept-Profile": core_schema,
        "Content-Profile": core_schema,
    }

    connector_rows = _fetch_json(
        base_url,
        headers,
        "connectors",
        {"select": "id,connector_code", "connector_code": f"eq.{args.connector_code}", "limit": "1"},
    )
    if not connector_rows:
        raise SystemExit(f"Connector not found: {args.connector_code}")
    connector_id = connector_rows[0].get("id")

    stations = _fetch_all(
        base_url,
        headers,
        "stations",
        {
            "select": "id,station_ref,service_ref,label,station_name,station_type,station_exposure,region,la_code,pcon_code,geometry,connector_id",
            "connector_id": f"eq.{connector_id}",
        },
    )
    station_ids = [str(row.get("id")) for row in stations if row.get("id") is not None]

    membership_rows: List[Dict[str, Any]] = []
    for chunk in _chunked(station_ids, 200):
        membership_rows.extend(
            _fetch_json(
                base_url,
                headers,
                "station_network_memberships",
                {
                    "select": "station_id,network_code,network_label,is_primary",
                    "station_id": f"in.({','.join(chunk)})",
                },
            )
        )

    memberships_by_station: Dict[int, List[Dict[str, Any]]] = {}
    for row in membership_rows:
        try:
            station_id = int(row.get("station_id"))
        except (TypeError, ValueError):
            continue
        memberships_by_station.setdefault(station_id, []).append(row)

    station_refs_rows: List[Dict[str, Any]] = []
    for chunk in _chunked(station_ids, 200):
        station_refs_rows.extend(
            _fetch_json(
                base_url,
                headers,
                "uk_air_sos_station_refs",
                {
                    "select": "station_id,uk_air_id,match_method,match_distance_m,source_snapshot_at",
                    "station_id": f"in.({','.join(chunk)})",
                },
            )
        )

    station_refs_by_station: Dict[int, Dict[str, Any]] = {}
    for row in station_refs_rows:
        try:
            station_id = int(row.get("station_id"))
        except (TypeError, ValueError):
            continue
        station_refs_by_station[station_id] = row

    snapshot_at = args.snapshot_at
    if not snapshot_at:
        snapshot_rows = _fetch_json(
            base_url,
            headers,
            "uk_air_sos_site_register",
            {"select": "snapshot_at", "order": "snapshot_at.desc", "limit": "1"},
        )
        if not snapshot_rows:
            raise SystemExit("No uk_air_sos_site_register snapshots found.")
        snapshot_at = snapshot_rows[0].get("snapshot_at")

    register_rows = _fetch_all(
        base_url,
        headers,
        "uk_air_sos_site_register",
        {
            "select": "uk_air_id,site_name,environment_type,zone,start_date,end_date,latitude,longitude,networks,aurn_pollutants_measured,site_description,source_file,snapshot_at",
            "snapshot_at": f"eq.{snapshot_at}",
        },
    )
    register_by_id: Dict[str, Dict[str, Any]] = {}
    for row in register_rows:
        uk_air_id = row.get("uk_air_id")
        if uk_air_id:
            register_by_id[str(uk_air_id)] = row

    network_lookup_rows = _fetch_all(
        base_url,
        headers,
        "uk_air_sos_networks",
        {"select": "network_ref,network_code,network_display_name"},
    )
    network_lookup: Dict[str, Dict[str, Any]] = {}
    for row in network_lookup_rows:
        ref = row.get("network_ref")
        if ref:
            network_lookup[str(ref)] = row

    rules_rows = _fetch_all(
        base_url,
        headers,
        "uk_air_sos_network_pollutants",
        {"select": "network_ref,match_type,match_value"},
    )
    rules: Dict[str, List[Tuple[str, str]]] = {}
    for row in rules_rows:
        ref = row.get("network_ref")
        if not ref:
            continue
        match_type = (row.get("match_type") or "contains").strip().lower()
        value = _normalize_pollutant_key(row.get("match_value"))
        if not value:
            continue
        rules.setdefault(str(ref), []).append((match_type, value))

    station_to_phenomena: Dict[int, Set[int]] = {}
    phenomena_ids: Set[int] = set()
    for chunk in _chunked(station_ids, 200):
        rows = _fetch_all(
            base_url,
            headers,
            "timeseries",
            {
                "select": "station_id,phenomenon_id",
                "station_id": f"in.({','.join(chunk)})",
                "phenomenon_id": "not.is.null",
            },
            limit=1000,
        )
        for row in rows:
            try:
                station_id = int(row.get("station_id"))
                phenomenon_id = int(row.get("phenomenon_id"))
            except (TypeError, ValueError):
                continue
            station_to_phenomena.setdefault(station_id, set()).add(phenomenon_id)
            phenomena_ids.add(phenomenon_id)

    phenomena_labels: Dict[int, List[str]] = {}
    phenomena_id_list = [str(pid) for pid in sorted(phenomena_ids)]
    for chunk in _chunked(phenomena_id_list, 200):
        rows = _fetch_json(
            base_url,
            headers,
            "phenomena",
            {"select": "id,label,notation,pollutant_label", "id": f"in.({','.join(chunk)})"},
        )
        for row in rows:
            try:
                phen_id = int(row.get("id"))
            except (TypeError, ValueError):
                continue
            phenomena_labels.setdefault(phen_id, []).extend(_pollutant_keys_from_phenomenon(row))

    station_pollutant_keys: Dict[int, Set[str]] = {}
    for station_id, phen_ids in station_to_phenomena.items():
        keys: Set[str] = set()
        for phen_id in phen_ids:
            for key in phenomena_labels.get(phen_id, []):
                if key:
                    keys.add(key)
        if keys:
            station_pollutant_keys[station_id] = keys

    now_stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    default_output = (
        Path("network_info/UK-Air-SOS")
        / f"uk_air_sos_membership_backfill_report_{now_stamp}.csv"
    )
    output_path = Path(args.output) if args.output else default_output
    output_path.parent.mkdir(parents=True, exist_ok=True)

    fieldnames = [
        "station_id",
        "station_ref",
        "service_ref",
        "station_label",
        "station_name",
        "station_type",
        "station_exposure",
        "region",
        "la_code",
        "pcon_code",
        "lat",
        "lon",
        "uk_air_id",
        "match_method",
        "match_distance_m",
        "match_snapshot_at",
        "register_site_name",
        "register_environment_type",
        "register_zone",
        "register_start_date",
        "register_end_date",
        "register_latitude",
        "register_longitude",
        "register_networks",
        "register_network_codes",
        "register_network_labels",
        "register_aurn_pollutants_measured",
        "register_site_description",
        "register_source_file",
        "register_snapshot_at",
        "pollutant_keys",
        "allowed_network_refs",
        "filtered_network_refs",
        "missing_rule_network_refs",
        "expected_network_codes",
        "expected_network_labels",
        "membership_network_codes",
        "membership_network_labels",
        "membership_primary_codes",
        "membership_count",
        "missing_memberships",
        "extra_memberships",
        "has_memberships",
        "missing_pollutants",
        "missing_register",
    ]

    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()

        for station in stations:
            station_id = station.get("id")
            if station_id is None:
                continue
            try:
                station_id_int = int(station_id)
            except (TypeError, ValueError):
                continue

            lat, lon = _coords_from_geometry(station.get("geometry"))

            membership_list = memberships_by_station.get(station_id_int, [])
            membership_codes = sorted(
                {row.get("network_code") for row in membership_list if row.get("network_code")}
            )
            membership_labels = sorted(
                {
                    row.get("network_label")
                    for row in membership_list
                    if row.get("network_label")
                }
            )
            membership_primary_codes = sorted(
                {
                    row.get("network_code")
                    for row in membership_list
                    if row.get("network_code") and row.get("is_primary")
                }
            )

            ref_row = station_refs_by_station.get(station_id_int) or {}
            uk_air_id = ref_row.get("uk_air_id")

            register_row = register_by_id.get(str(uk_air_id)) if uk_air_id else None
            register_networks = register_row.get("networks") if isinstance(register_row, dict) else []
            if not isinstance(register_networks, list):
                register_networks = []

            register_network_codes: List[str] = []
            register_network_labels: List[str] = []
            for ref in register_networks:
                entry = network_lookup.get(str(ref))
                if not entry:
                    continue
                code = entry.get("network_code")
                label = entry.get("network_display_name") or entry.get("network_ref") or code
                if code:
                    register_network_codes.append(str(code))
                if label:
                    register_network_labels.append(str(label))

            pollutant_keys = station_pollutant_keys.get(station_id_int, set())

            allowed_refs: List[str] = []
            filtered_refs: List[str] = []
            missing_rule_refs: List[str] = []
            if register_networks:
                for ref in register_networks:
                    ref_str = str(ref)
                    if ref_str not in rules:
                        missing_rule_refs.append(ref_str)
                        continue
                    if _network_allows_pollutants(ref_str, pollutant_keys, rules):
                        allowed_refs.append(ref_str)
                    else:
                        filtered_refs.append(ref_str)

            expected_codes: List[str] = []
            expected_labels: List[str] = []
            for ref in allowed_refs:
                entry = network_lookup.get(str(ref))
                if not entry:
                    continue
                code = entry.get("network_code")
                label = entry.get("network_display_name") or entry.get("network_ref") or code
                if code:
                    expected_codes.append(str(code))
                if label:
                    expected_labels.append(str(label))

            expected_codes = sorted(set(expected_codes))
            expected_labels = sorted(set(expected_labels))
            register_network_codes = sorted(set(register_network_codes))
            register_network_labels = sorted(set(register_network_labels))

            missing_memberships = sorted(set(expected_codes) - set(membership_codes))
            extra_memberships = sorted(set(membership_codes) - set(expected_codes))

            row = {
                "station_id": station_id_int,
                "station_ref": station.get("station_ref"),
                "service_ref": station.get("service_ref"),
                "station_label": station.get("label"),
                "station_name": station.get("station_name"),
                "station_type": station.get("station_type"),
                "station_exposure": station.get("station_exposure"),
                "region": station.get("region"),
                "la_code": station.get("la_code"),
                "pcon_code": station.get("pcon_code"),
                "lat": lat,
                "lon": lon,
                "uk_air_id": uk_air_id,
                "match_method": ref_row.get("match_method"),
                "match_distance_m": ref_row.get("match_distance_m"),
                "match_snapshot_at": ref_row.get("source_snapshot_at"),
                "register_site_name": register_row.get("site_name") if register_row else None,
                "register_environment_type": register_row.get("environment_type") if register_row else None,
                "register_zone": register_row.get("zone") if register_row else None,
                "register_start_date": register_row.get("start_date") if register_row else None,
                "register_end_date": register_row.get("end_date") if register_row else None,
                "register_latitude": register_row.get("latitude") if register_row else None,
                "register_longitude": register_row.get("longitude") if register_row else None,
                "register_networks": _join(register_networks),
                "register_network_codes": _join(register_network_codes),
                "register_network_labels": _join(register_network_labels),
                "register_aurn_pollutants_measured": register_row.get("aurn_pollutants_measured") if register_row else None,
                "register_site_description": register_row.get("site_description") if register_row else None,
                "register_source_file": register_row.get("source_file") if register_row else None,
                "register_snapshot_at": register_row.get("snapshot_at") if register_row else None,
                "pollutant_keys": _join(sorted(pollutant_keys)),
                "allowed_network_refs": _join(allowed_refs),
                "filtered_network_refs": _join(filtered_refs),
                "missing_rule_network_refs": _join(missing_rule_refs),
                "expected_network_codes": _join(expected_codes),
                "expected_network_labels": _join(expected_labels),
                "membership_network_codes": _join(membership_codes),
                "membership_network_labels": _join(membership_labels),
                "membership_primary_codes": _join(membership_primary_codes),
                "membership_count": len(membership_codes),
                "missing_memberships": _join(missing_memberships),
                "extra_memberships": _join(extra_memberships),
                "has_memberships": bool(membership_codes),
                "missing_pollutants": not bool(pollutant_keys),
                "missing_register": not bool(register_row),
            }
            writer.writerow(row)

    print(f"Wrote report: {output_path}")


if __name__ == "__main__":
    main()
