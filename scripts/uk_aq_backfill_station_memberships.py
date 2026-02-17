#!/usr/bin/env python3
"""
Backfill station memberships and station_type from UK-AIR SOS sources.

Default source is the UK-AIR monitoring sites register (uk_air_sos_site_register),
with optional fallback to SOS stationType values.
Network memberships from the register are filtered by uk_air_sos_network_pollutants.

Requires:
- SUPABASE_URL
- SB_SECRET_KEY
"""

import argparse
import logging
import math
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scripts.ingest_helpers import station_coords, station_in_bbox_or_missing_coords
from scripts.uk_air_sos.uk_air_sos_list_stations import (
    UK_BBOX,
    SupabaseWriter,
    UkAirClient,
    _chunked,
    _derive_station_name,
    _index_station_rows,
    _resolve_service_ref,
    _resolve_station_ref,
    _select_station_row,
    _select_primary_service,
    _station_service_map_from_timeseries,
    _station_network_codes,
    _station_type_from_payload,
    apply_station_enrichment,
)

load_dotenv()

LOG = logging.getLogger("uk_aq_backfill_station_memberships")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

DEFAULT_MATCH_DISTANCE_M = 1000.0
DEFAULT_MATCH_DISTANCE_NO_NAME_M = 250.0
_POLLUTANT_PARENS_RE = re.compile(r"\s*\([^)]*\)")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Backfill station_network_memberships and station_type from UK-AIR SOS data sources."
        ),
    )
    parser.add_argument(
        "--source",
        choices=("site-register", "sos"),
        default="site-register",
        help="Membership source: site-register (default) or SOS stationType.",
    )
    parser.add_argument(
        "--snapshot-at",
        help="Use a specific uk_air_sos_site_register snapshot_at value (default: latest).",
    )
    parser.add_argument(
        "--match-distance-m",
        type=float,
        default=DEFAULT_MATCH_DISTANCE_M,
        help="Max distance (meters) for site register matches (default: 1000).",
    )
    parser.add_argument(
        "--match-distance-no-name-m",
        type=float,
        default=DEFAULT_MATCH_DISTANCE_NO_NAME_M,
        help="Max distance (meters) for matches without name alignment (default: 250).",
    )
    parser.add_argument(
        "--no-filter",
        action="store_true",
        help="Skip the UK bounding box filter and process all stations.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="Limit the number of stations processed.",
    )
    parser.add_argument(
        "--metadata-batch-size",
        type=int,
        default=50,
        help="Batch size for timeseries metadata requests (default: 50).",
    )
    parser.add_argument(
        "--write-batch-size",
        type=int,
        default=200,
        help="Batch size for Supabase upserts (default: 200).",
    )
    parser.add_argument(
        "--service-ref-from-timeseries",
        "--service-id-from-timeseries",
        action="store_true",
        help="Resolve service_ref using timeseries metadata instead of defaulting to a single service.",
    )
    parser.add_argument(
        "--skip-station-metadata",
        action="store_true",
        help="Skip station_metadata upserts.",
    )
    parser.add_argument(
        "--skip-network-memberships",
        action="store_true",
        help="Skip station_network_memberships upserts.",
    )
    parser.add_argument(
        "--skip-station-type-backfill",
        action="store_true",
        help="Skip station_type updates.",
    )
    parser.add_argument(
        "--report-station-types",
        action="store_true",
        help="Log the most common stationType values and derived network codes.",
    )
    return parser.parse_args()


def _normalize_name(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    cleaned = re.sub(r"[^A-Za-z0-9]+", " ", value).strip().upper()
    return cleaned or None


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
    stripped = _POLLUTANT_PARENS_RE.sub("", raw).strip()
    keys = {_normalize_pollutant_key(raw), _normalize_pollutant_key(stripped)}
    return [key for key in keys if key]


def _pollutant_keys_from_phenomenon(row: Dict[str, Any]) -> List[str]:
    keys: List[str] = []
    for field in ("pollutant_label", "label", "notation"):
        keys.extend(_pollutant_keys_from_text(row.get(field)))
    return keys


def _fetch_network_pollutant_rules(writer: SupabaseWriter) -> Dict[str, List[Tuple[str, str]]]:
    resp = (
        writer.core.table("uk_air_sos_network_pollutants")
        .select("network_ref,match_type,match_value")
        .execute()
    )
    rows = resp.data if hasattr(resp, "data") else resp.get("data")
    rules: Dict[str, List[Tuple[str, str]]] = {}
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        ref = row.get("network_ref")
        if not ref:
            continue
        match_type = (row.get("match_type") or "contains").strip().lower()
        value = _normalize_pollutant_key(row.get("match_value"))
        if not value:
            continue
        rules.setdefault(str(ref), []).append((match_type, value))
    return rules


def _fetch_station_pollutant_keys(
    writer: SupabaseWriter, station_ids: Sequence[int], batch_size: int
) -> Dict[int, Set[str]]:
    if not station_ids:
        return {}
    station_to_phenomena: Dict[int, Set[int]] = {}
    phenomena_ids: Set[int] = set()
    for chunk in _chunked([str(val) for val in station_ids], batch_size):
        resp = (
            writer.core.table("timeseries")
            .select("station_id,phenomenon_id")
            .in_("station_id", list(chunk))
            .execute()
        )
        rows = resp.data if hasattr(resp, "data") else resp.get("data")
        for row in rows or []:
            try:
                station_id = int(row.get("station_id"))
                phenomenon_id = int(row.get("phenomenon_id"))
            except (TypeError, ValueError):
                continue
            station_to_phenomena.setdefault(station_id, set()).add(phenomenon_id)
            phenomena_ids.add(phenomenon_id)

    phenomena_labels: Dict[int, List[str]] = {}
    for chunk in _chunked([str(val) for val in phenomena_ids], batch_size):
        resp = (
            writer.core.table("phenomena")
            .select("id,label,notation,pollutant_label")
            .in_("id", list(chunk))
            .execute()
        )
        rows = resp.data if hasattr(resp, "data") else resp.get("data")
        for row in rows or []:
            try:
                phen_id = int(row.get("id"))
            except (TypeError, ValueError):
                continue
            phenomena_labels.setdefault(phen_id, []).extend(_pollutant_keys_from_phenomenon(row))

    station_pollutants: Dict[int, Set[str]] = {}
    for station_id, phen_ids in station_to_phenomena.items():
        keys: Set[str] = set()
        for phen_id in phen_ids:
            for key in phenomena_labels.get(phen_id, []):
                if key:
                    keys.add(key)
        if keys:
            station_pollutants[station_id] = keys
    return station_pollutants


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


def _station_display_name(station: Dict[str, Any]) -> Optional[str]:
    if not isinstance(station, dict):
        return None
    props = station.get("properties", {}) if isinstance(station.get("properties"), dict) else {}
    label = station.get("label") or props.get("label") or props.get("name")
    if label:
        derived = _derive_station_name(str(label))
        return derived or str(label).strip() or None
    return None


def _haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    radius_m = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = (
        math.sin(delta_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    )
    return 2 * radius_m * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _find_register_match(
    station: Dict[str, Any],
    register_rows: Sequence[Dict[str, Any]],
    max_distance_m: float,
    max_distance_no_name_m: float,
) -> Tuple[Optional[Dict[str, Any]], Optional[float], Optional[str], str]:
    lon, lat = station_coords(station, bbox=UK_BBOX)
    if lon is None or lat is None:
        return None, None, None, "missing-coords"

    station_name = _station_display_name(station)
    normalized_station = _normalize_name(station_name)
    candidates: List[Tuple[float, Dict[str, Any]]] = []
    for row in register_rows:
        row_lon = row.get("longitude")
        row_lat = row.get("latitude")
        if row_lon is None or row_lat is None:
            continue
        try:
            distance = _haversine_m(float(lon), float(lat), float(row_lon), float(row_lat))
        except (TypeError, ValueError):
            continue
        if distance <= max_distance_m:
            candidates.append((distance, row))

    if not candidates:
        return None, None, None, "no-match"

    candidates.sort(key=lambda item: item[0])
    if len(candidates) == 1:
        return candidates[0][1], candidates[0][0], "distance", "matched"

    if normalized_station:
        named = [
            (dist, row)
            for dist, row in candidates
            if _normalize_name(row.get("site_name")) == normalized_station
        ]
        if len(named) == 1:
            return named[0][1], named[0][0], "name+distance", "matched"
        if len(named) > 1:
            named.sort(key=lambda item: item[0])
            if named[0][0] <= max_distance_no_name_m and len(
                [item for item in named if item[0] <= max_distance_no_name_m]
            ) == 1:
                return named[0][1], named[0][0], "name+distance", "matched"
            return None, None, None, "ambiguous"

    close = [item for item in candidates if item[0] <= max_distance_no_name_m]
    if len(close) == 1:
        return close[0][1], close[0][0], "distance", "matched"
    return None, None, None, "ambiguous"


def _primary_network_code(codes: Iterable[str]) -> Optional[str]:
    unique = sorted({code for code in codes if code})
    if len(unique) == 1:
        return unique[0]
    if "gov_uk_aurn" in unique:
        return "gov_uk_aurn"
    return None


def _network_codes_for_register(
    network_refs: Iterable[str],
    network_lookup: Dict[str, Dict[str, Any]],
) -> Dict[str, str]:
    codes: Dict[str, str] = {}
    for ref in network_refs:
        entry = network_lookup.get(str(ref))
        if not entry:
            continue
        code = entry.get("network_code")
        if not code:
            continue
        label = entry.get("network_display_name") or entry.get("network_ref") or str(ref)
        if code not in codes:
            codes[code] = label
    return codes


def _upsert_with_progress(
    writer: SupabaseWriter,
    table: str,
    rows: List[Dict[str, Any]],
    on_conflict: str,
    batch_size: int,
) -> int:
    if not rows:
        return 0
    for idx in range(0, len(rows), batch_size):
        chunk = rows[idx : idx + batch_size]
        print(".", end="", flush=True)
        writer.core.table(table).upsert(chunk, on_conflict=on_conflict).execute()
    print()
    return len(rows)


def _update_station_types(
    writer: SupabaseWriter, rows: List[Dict[str, Any]], batch_size: int
) -> int:
    if not rows:
        return 0
    grouped: Dict[str, List[int]] = {}
    for row in rows:
        station_type = row.get("station_type")
        if not station_type:
            continue
        try:
            station_id = int(row.get("id"))
        except (TypeError, ValueError):
            continue
        grouped.setdefault(str(station_type), []).append(station_id)

    updated = 0
    for station_type, station_ids in grouped.items():
        for idx in range(0, len(station_ids), batch_size):
            chunk = station_ids[idx : idx + batch_size]
            print(".", end="", flush=True)
            writer.core.table("stations").update({"station_type": station_type}).in_(
                "id", chunk
            ).execute()
            updated += len(chunk)
    if grouped:
        print()
    return updated


def _resolve_station_ids(stations: List[dict]) -> List[str]:
    ids = []
    for station in stations:
        if not isinstance(station, dict):
            continue
        props = station.get("properties", {}) if isinstance(station.get("properties"), dict) else {}
        station_id = station.get("id") or props.get("id")
        if station_id:
            ids.append(str(station_id))
    return ids


def _report_station_types(stations: List[dict]) -> None:
    type_counts: Counter[str] = Counter()
    network_counts: Counter[str] = Counter()
    for station in stations:
        if not isinstance(station, dict):
            continue
        station_type = _station_type_from_payload(station)
        if station_type:
            type_counts[station_type] += 1
            for code in _station_network_codes(station_type):
                network_counts[code] += 1
    if not type_counts:
        LOG.info("No stationType values found in SOS payload.")
        return
    top_types = ", ".join(
        f"{label}={count}" for label, count in type_counts.most_common(10)
    )
    top_networks = ", ".join(
        f"{label}={count}" for label, count in network_counts.most_common(10)
    )
    LOG.info("Top stationType values: %s", top_types)
    LOG.info("Derived network codes: %s", top_networks or "<none>")


def main() -> int:
    args = parse_args()
    client = UkAirClient()
    services = client.services()
    primary_service = _select_primary_service(services)
    default_service_ref = None
    if primary_service and primary_service.get("id") is not None:
        default_service_ref = str(primary_service.get("id"))

    stations = client.stations()
    if not stations:
        LOG.warning("No stations returned from UK-AIR SOS.")
    filtered = (
        stations
        if args.no_filter
        else [s for s in stations if station_in_bbox_or_missing_coords(s, UK_BBOX)]
    )
    if args.limit is not None:
        filtered = filtered[: args.limit]
    if args.report_station_types:
        if args.source == "sos":
            _report_station_types(filtered)
        else:
            LOG.info("--report-station-types only applies to --source sos.")

    station_service_ref_map: Dict[str, str] = {}
    if args.service_ref_from_timeseries:
        station_ids = _resolve_station_ids(filtered)
        service_refs = [svc.get("id") for svc in services if svc.get("id")]
        station_service_ref_map = _station_service_map_from_timeseries(
            client, station_ids, service_refs, args.metadata_batch_size
        )
        LOG.info("Resolved service ref from timeseries for %s stations.", len(station_service_ref_map))

    writer = SupabaseWriter()
    connector_id = writer.upsert_connectors(services)
    if connector_id is None:
        raise RuntimeError("Failed to resolve connector id for UK-AIR SOS.")

    if args.source == "sos":
        enrichment = apply_station_enrichment(
            writer,
            filtered,
            connector_id,
            station_service_ref_map=station_service_ref_map,
            default_service_ref=default_service_ref,
            update_station_type=not args.skip_station_type_backfill,
            skip_metadata=args.skip_station_metadata,
            skip_memberships=args.skip_network_memberships,
        )
        if args.report_station_types and not args.skip_network_memberships:
            if enrichment["membership_rows"] == 0:
                LOG.warning(
                    "No memberships generated; stationType values may not map to AURN/LAQN/WAQN."
                )
        LOG.info(
            "Backfill complete: station_refs=%s station_rows=%s station_type_updates=%s "
            "metadata_updates=%s membership_rows=%s missing_station=%s ambiguous_station=%s",
            enrichment["station_refs"],
            enrichment["station_rows"],
            enrichment["station_type_updates"],
            enrichment["metadata_updates"],
            enrichment["membership_rows"],
            enrichment["missing_station"],
            enrichment["ambiguous_station"],
        )
        return 0

    snapshot_at = args.snapshot_at or writer.fetch_latest_site_register_snapshot()
    if not snapshot_at:
        raise RuntimeError("No uk_air_sos_site_register snapshot found; run the site register load.")
    register_rows = writer.fetch_site_register_rows(snapshot_at)
    if not register_rows:
        raise RuntimeError(f"No uk_air_sos_site_register rows found for snapshot {snapshot_at}.")
    register_by_id = {
        row.get("uk_air_id"): row for row in register_rows if row.get("uk_air_id")
    }
    network_lookup = writer.fetch_uk_air_sos_networks()
    network_rules = _fetch_network_pollutant_rules(writer)
    if not network_rules:
        LOG.warning("No uk_air_sos_network_pollutants rules found; memberships will be empty.")
    has_network_codes = any(
        row.get("network_code") for row in network_lookup.values() if isinstance(row, dict)
    )
    if not has_network_codes:
        LOG.warning("No network_code values set in uk_air_sos_networks; memberships will be empty.")

    station_refs = sorted(
        {
            ref
            for ref in (
                _resolve_station_ref(station)
                for station in filtered
                if isinstance(station, dict)
            )
            if ref
        }
    )
    station_rows = writer.fetch_station_rows(connector_id, station_refs)
    station_rows_map = _index_station_rows(station_rows)
    station_ids = []
    for row in station_rows:
        try:
            station_ids.append(int(row.get("id")))
        except (TypeError, ValueError):
            continue
    existing_refs = writer.fetch_uk_air_sos_station_refs(station_ids)
    pollutant_batch_size = min(args.write_batch_size, 50)
    station_pollutant_keys = _fetch_station_pollutant_keys(
        writer, station_ids, batch_size=pollutant_batch_size
    )

    membership_rows: List[Dict[str, Any]] = []
    membership_keys = set()
    station_type_updates: List[Dict[str, Any]] = []
    station_ref_rows: List[Dict[str, Any]] = []
    missing_station = 0
    ambiguous_station = 0
    missing_coords = 0
    missing_register = 0
    ambiguous_match = 0
    unmatched = 0
    skipped_existing = 0
    missing_pollutants = 0
    filtered_networks = 0
    missing_network_rules = set()
    unmapped_network_refs = set()

    for station in filtered:
        if not isinstance(station, dict):
            continue
        station_ref = _resolve_station_ref(station)
        if not station_ref:
            continue
        service_ref = _resolve_service_ref(
            station,
            station_ref,
            station_service_ref_map,
            default_service_ref,
        )
        row = _select_station_row(station_ref, service_ref, station_rows_map)
        if row is None:
            if station_ref in station_rows_map and service_ref is None:
                ambiguous_station += 1
            else:
                missing_station += 1
            continue

        try:
            station_id = int(row.get("id"))
        except (TypeError, ValueError):
            continue

        existing = existing_refs.get(station_id)
        uk_air_id = None
        match_distance = None
        match_method = None
        if existing:
            uk_air_id = existing.get("uk_air_id")
            match_distance = existing.get("match_distance_m")
            match_method = existing.get("match_method") or "existing"
            skipped_existing += 1
        else:
            match_row, match_distance, match_method, status = _find_register_match(
                station,
                register_rows,
                args.match_distance_m,
                args.match_distance_no_name_m,
            )
            if status == "missing-coords":
                missing_coords += 1
                continue
            if status == "ambiguous":
                ambiguous_match += 1
                continue
            if status != "matched" or not match_row:
                unmatched += 1
                continue
            uk_air_id = match_row.get("uk_air_id")
            if uk_air_id:
                station_ref_rows.append(
                    {
                        "station_id": station_id,
                        "uk_air_id": uk_air_id,
                        "match_method": match_method,
                        "match_distance_m": match_distance,
                        "source_snapshot_at": snapshot_at,
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    }
                )

        if not uk_air_id:
            missing_register += 1
            continue

        register = register_by_id.get(uk_air_id)
        if not register:
            missing_register += 1
            continue

        network_refs = register.get("networks") or []
        if not isinstance(network_refs, list):
            network_refs = []

        pollutant_keys = station_pollutant_keys.get(station_id)
        if not pollutant_keys:
            missing_pollutants += 1
            continue

        filtered_refs: List[str] = []
        for ref in network_refs:
            if _network_allows_pollutants(ref, pollutant_keys, network_rules):
                filtered_refs.append(ref)
                continue
            filtered_networks += 1
            if ref not in network_rules:
                missing_network_rules.add(str(ref))

        if not filtered_refs:
            continue

        code_labels = _network_codes_for_register(filtered_refs, network_lookup)
        if not code_labels:
            unmapped_network_refs.update(filtered_refs)
            continue

        primary_code = _primary_network_code(code_labels.keys())
        if not args.skip_network_memberships:
            for code, label in code_labels.items():
                key = (station_id, code)
                if key in membership_keys:
                    continue
                membership_keys.add(key)
                membership_rows.append(
                    {
                        "station_id": station_id,
                        "network_code": code,
                        "network_label": label,
                        "is_primary": code == primary_code,
                    }
                )
        if not args.skip_station_type_backfill and primary_code:
            if row.get("station_type") != primary_code:
                station_type_updates.append({"id": station_id, "station_type": primary_code})

    if station_ref_rows:
        LOG.info("Upserting uk_air_sos_station_refs...")
        _upsert_with_progress(
            writer,
            "uk_air_sos_station_refs",
            station_ref_rows,
            on_conflict="station_id",
            batch_size=args.write_batch_size,
        )
    if station_type_updates:
        LOG.info("Updating station_type for %s stations...", len(station_type_updates))
        _update_station_types(writer, station_type_updates, batch_size=args.write_batch_size)
    if not args.skip_network_memberships and membership_rows:
        LOG.info("Upserting station_network_memberships...")
        _upsert_with_progress(
            writer,
            "station_network_memberships",
            membership_rows,
            on_conflict="station_id,network_code",
            batch_size=args.write_batch_size,
        )

    LOG.info(
        "Backfill complete: station_refs=%s station_rows=%s membership_rows=%s "
        "station_type_updates=%s station_refs_upserted=%s missing_station=%s ambiguous_station=%s "
        "missing_coords=%s ambiguous_match=%s unmatched=%s missing_register=%s skipped_existing=%s "
        "missing_pollutants=%s filtered_networks=%s",
        len(station_refs),
        len(station_rows),
        len(membership_rows),
        len(station_type_updates),
        len(station_ref_rows),
        missing_station,
        ambiguous_station,
        missing_coords,
        ambiguous_match,
        unmatched,
        missing_register,
        skipped_existing,
        missing_pollutants,
        filtered_networks,
    )
    if unmapped_network_refs:
        LOG.warning(
            "Unmapped network labels (no network_code set): %s",
            ", ".join(sorted(str(val) for val in unmapped_network_refs)),
        )
    if missing_network_rules:
        LOG.warning(
            "Networks missing pollutant rules: %s",
            ", ".join(sorted(str(val) for val in missing_network_rules)),
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
