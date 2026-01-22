#!/usr/bin/env python3
"""
List London Air Quality Network (LAQN) stations via the UK-AIR SOS API.

Examples:
  python3 scripts/gov_uk_laqn/gov_uk_laqn_list_stations.py
  python3 scripts/gov_uk_laqn/gov_uk_laqn_list_stations.py --format csv --output laqn_stations.csv
  python3 scripts/gov_uk_laqn/gov_uk_laqn_list_stations.py --to-supabase
"""

import argparse
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scripts.ingest_helpers import station_in_bbox_or_missing_coords
from scripts.uk_air_sos.uk_air_sos_list_stations import (
    UK_BBOX,
    SupabaseWriter,
    UkAirClient,
    _is_placeholder_station_ref,
    _normalize_station,
    _resolve_station_ref,
    _select_primary_service,
    _station_network_codes,
    _station_service_map_from_timeseries,
    _station_type_from_payload,
    _write_csv,
    _write_json,
    apply_station_enrichment,
)

LOG = logging.getLogger("gov_uk_laqn_stations")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

NETWORK_CODE = "laqn"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _is_laqn_station(station: Dict[str, Any]) -> bool:
    station_type = _station_type_from_payload(station)
    codes = _station_network_codes(station_type)
    return NETWORK_CODE in codes


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch LAQN stations from UK-AIR SOS.")
    parser.add_argument(
        "--output",
        default="gov_uk_laqn_stations.json",
        help="Output file path (default: gov_uk_laqn_stations.json).",
    )
    parser.add_argument(
        "--format",
        choices=("json", "csv"),
        default="json",
        help="Output format (json or csv).",
    )
    parser.add_argument(
        "--raw-output",
        help="Write raw station payloads to this file (JSON only).",
    )
    parser.add_argument(
        "--no-filter",
        action="store_true",
        help="Skip the UK bounding box filter and save all stations.",
    )
    parser.add_argument(
        "--to-supabase",
        action="store_true",
        help="Upsert stations into Supabase (requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).",
    )
    parser.add_argument(
        "--metadata-batch-size",
        type=int,
        default=50,
        help="Batch size for timeseries metadata requests (default: 50).",
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
        help="Skip station_metadata upserts when writing to Supabase.",
    )
    parser.add_argument(
        "--skip-network-memberships",
        action="store_true",
        help="Skip station_network_memberships upserts when writing to Supabase.",
    )
    parser.add_argument(
        "--skip-station-type-backfill",
        action="store_true",
        help="Skip station_type updates when writing to Supabase.",
    )
    return parser.parse_args()


def _filter_laqn_stations(stations: List[Dict[str, Any]], skip_bbox: bool) -> List[Dict[str, Any]]:
    filtered = (
        stations
        if skip_bbox
        else [station for station in stations if station_in_bbox_or_missing_coords(station, UK_BBOX)]
    )
    laqn_only = [station for station in filtered if _is_laqn_station(station)]
    placeholder_refs = {
        _resolve_station_ref(station)
        for station in laqn_only
        if _is_placeholder_station_ref(_resolve_station_ref(station))
    }
    if placeholder_refs:
        LOG.warning(
            "Skipping %s placeholder station(s) with refs=%s",
            len(placeholder_refs),
            ", ".join(sorted({ref for ref in placeholder_refs if ref})),
        )
        laqn_only = [
            station
            for station in laqn_only
            if not _is_placeholder_station_ref(_resolve_station_ref(station))
        ]
    return laqn_only


def _resolve_service_ref_map(
    client: UkAirClient,
    stations: List[Dict[str, Any]],
    services: List[Dict[str, Any]],
    batch_size: int,
    enabled: bool,
) -> Dict[str, str]:
    if not enabled:
        return {}
    station_ids = [
        station.get("id") or (station.get("properties") or {}).get("id")
        for station in stations
        if station.get("id") or (station.get("properties") or {}).get("id")
    ]
    service_refs = [svc.get("id") for svc in services if svc.get("id")]
    mapping = _station_service_map_from_timeseries(client, station_ids, service_refs, batch_size)
    LOG.info("Resolved service ref from timeseries for %s stations.", len(mapping))
    return mapping


def main() -> int:
    args = parse_args()
    run_at = utcnow()
    client = UkAirClient()
    services = client.services()
    primary_service = _select_primary_service(services)
    default_service_ref = None
    if primary_service and primary_service.get("id") is not None:
        default_service_ref = str(primary_service.get("id"))

    stations = client.stations()
    if not stations:
        LOG.warning("No stations returned from UK-AIR SOS.")

    laqn_stations = _filter_laqn_stations(stations, args.no_filter)
    LOG.info("LAQN stations=%s (from total=%s)", len(laqn_stations), len(stations))

    station_service_ref_map = _resolve_service_ref_map(
        client,
        laqn_stations,
        services,
        args.metadata_batch_size,
        args.service_ref_from_timeseries,
    )

    if args.raw_output:
        _write_json(
            args.raw_output,
            {
                "generated_at": run_at.isoformat(),
                "station_count": len(laqn_stations),
                "stations": laqn_stations,
            },
        )

    if args.to_supabase:
        writer = SupabaseWriter()
        connector_id = writer.upsert_connectors(services)
        if connector_id is None:
            raise RuntimeError("Failed to resolve connector id for UK-AIR SOS.")
        inserted = writer.upsert_stations(
            laqn_stations,
            connector_id,
            run_at,
            station_service_ref_map=station_service_ref_map,
            default_service_ref=default_service_ref,
        )
        LOG.info("Upserted %s LAQN stations into Supabase.", inserted)
        backfilled = writer.backfill_station_names([connector_id])
        if backfilled:
            LOG.info("Backfilled station_name for %s stations.", backfilled)
        enrichment = apply_station_enrichment(
            writer,
            laqn_stations,
            connector_id,
            station_service_ref_map=station_service_ref_map,
            default_service_ref=default_service_ref,
            update_station_type=not args.skip_station_type_backfill,
            skip_metadata=args.skip_station_metadata,
            skip_memberships=args.skip_network_memberships,
        )
        if not args.skip_station_type_backfill:
            LOG.info("Backfilled station_type for %s stations.", enrichment["station_type_updates"])
        if not args.skip_station_metadata:
            LOG.info("Upserted station_metadata for %s stations.", enrichment["metadata_updates"])
        if not args.skip_network_memberships:
            LOG.info(
                "Upserted %s station_network_memberships rows.",
                enrichment["membership_rows"],
            )
        if enrichment["missing_station"]:
            LOG.warning(
                "Station enrichment skipped %s stations missing in DB.",
                enrichment["missing_station"],
            )
        if enrichment["ambiguous_station"]:
            LOG.warning(
                "Station enrichment skipped %s stations with ambiguous service_ref.",
                enrichment["ambiguous_station"],
            )

    if args.format == "csv":
        _write_csv(
            args.output,
            laqn_stations,
            service_ref_map=station_service_ref_map,
            default_service_ref=default_service_ref,
        )
    else:
        payload = {
            "generated_at": run_at.isoformat(),
            "station_count": len(laqn_stations),
            "stations": [
                _normalize_station(
                    station,
                    service_ref_map=station_service_ref_map,
                    default_service_ref=default_service_ref,
                )
                for station in laqn_stations
            ],
        }
        _write_json(args.output, payload)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
