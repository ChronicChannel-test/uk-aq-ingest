#!/usr/bin/env python3
"""
Load Parliamentary Constituency boundaries into Supabase for station-to-PCON mapping.

Requires:
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY

The GeoJSON file should contain Polygon or MultiPolygon geometries and
properties for constituency code/name fields.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from dotenv import load_dotenv
from supabase import create_client

load_dotenv()


def polygon_to_wkt(coords: List[List[List[float]]]) -> str:
    rings = []
    for ring in coords:
        points = ", ".join(f"{point[0]} {point[1]}" for point in ring)
        rings.append(f"({points})")
    return f"({', '.join(rings)})"


def multipolygon_to_wkt(coords: List[List[List[List[float]]]]) -> str:
    polygons = [polygon_to_wkt(poly) for poly in coords]
    return f"MULTIPOLYGON({', '.join(polygons)})"


def geometry_to_wkt(geometry: Dict[str, Any]) -> Optional[str]:
    geom_type = geometry.get("type")
    coords = geometry.get("coordinates")
    if geom_type == "Polygon":
        return f"MULTIPOLYGON({polygon_to_wkt(coords)})"
    if geom_type == "MultiPolygon":
        return multipolygon_to_wkt(coords)
    return None


def chunked(items: List[Dict[str, Any]], size: int) -> Iterable[List[Dict[str, Any]]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


def load_geojson(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Load PCON boundaries into Supabase.")
    parser.add_argument("--geojson", required=True, help="Path to a GeoJSON boundary file.")
    parser.add_argument("--pcon-version", required=True, help="Boundary dataset version (e.g., 2024).")
    parser.add_argument("--code-field", default="PCON24CD", help="GeoJSON property for PCON code.")
    parser.add_argument("--name-field", default="PCON24NM", help="GeoJSON property for PCON name.")
    parser.add_argument("--batch-size", type=int, default=10, help="Rows per upsert batch.")
    parser.add_argument(
        "--sleep-seconds",
        type=float,
        default=0.2,
        help="Sleep between batches to reduce DB load (seconds).",
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        default=5,
        help="Max retries per batch on transient errors.",
    )
    parser.add_argument(
        "--retry-backoff-seconds",
        type=float,
        default=2.0,
        help="Base backoff seconds between retries.",
    )
    parser.add_argument(
        "--history-partitions",
        type=int,
        default=1,
        help="Number of partitions for history updates.",
    )
    parser.add_argument(
        "--history-partition-index",
        type=int,
        help="Run a single history partition index (0-based).",
    )
    parser.add_argument(
        "--skip-boundaries",
        action="store_true",
        help="Skip boundary uploads (only run update flags).",
    )
    parser.add_argument(
        "--skip-if-exists",
        action="store_true",
        help="Skip boundary uploads if the target PCON version already exists.",
    )
    parser.add_argument(
        "--update-stations",
        action="store_true",
        help="Update stations with PCON codes after loading boundaries.",
    )
    parser.add_argument(
        "--stations-partitions",
        type=int,
        default=1,
        help="Number of partitions for station updates.",
    )
    parser.add_argument(
        "--stations-partition-index",
        type=int,
        help="Run a single station partition index (0-based).",
    )
    parser.add_argument(
        "--update-history",
        action="store_true",
        help="Update station_pcon_history for the provided PCON version.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    supabase_url = os.getenv("SUPABASE_URL")
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_role_key:
        print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.", file=sys.stderr)
        return 1

    geojson_path = Path(args.geojson)
    if not geojson_path.exists():
        print(f"GeoJSON not found: {geojson_path}", file=sys.stderr)
        return 1

    payload = load_geojson(geojson_path)
    features = payload.get("features") if isinstance(payload, dict) else None
    if not isinstance(features, list):
        print("GeoJSON does not contain a FeatureCollection.", file=sys.stderr)
        return 1

    client = create_client(supabase_url, service_role_key)

    rows: List[Dict[str, Any]] = []
    skipped = 0
    skip_due_to_exists = False
    if args.skip_if_exists and not args.skip_boundaries:
        try:
            existing = (
                client.table("pcon_boundaries")
                .select("pcon_code")
                .eq("pcon_version", args.pcon_version)
                .limit(1)
                .execute()
            )
            existing_rows = getattr(existing, "data", None)
        except Exception as exc:  # pragma: no cover - defensive logging
            print(f"Failed to check existing boundaries: {exc}", file=sys.stderr)
            existing_rows = None

        if existing_rows:
            print(f"Boundaries already exist for {args.pcon_version}; skipping upload.")
            args.skip_boundaries = True
            skip_due_to_exists = True
    if not args.skip_boundaries:
        for feature in features:
            geometry = feature.get("geometry") if isinstance(feature, dict) else None
            props = feature.get("properties") if isinstance(feature, dict) else None
            if not geometry or not props:
                skipped += 1
                continue
            pcon_code = props.get(args.code_field)
            if not pcon_code:
                skipped += 1
                continue
            wkt = geometry_to_wkt(geometry)
            if not wkt:
                skipped += 1
                continue
            rows.append(
                {
                    "pcon_code": str(pcon_code),
                    "pcon_name": props.get(args.name_field),
                    "pcon_version": args.pcon_version,
                    "geometry": f"SRID=4326;{wkt}",
                }
            )

        if not rows:
            print("No boundaries parsed from the GeoJSON file.", file=sys.stderr)
            return 1

        print("Uploading boundaries", end="", flush=True)
        for batch in chunked(rows, max(1, args.batch_size)):
            for attempt in range(1, max(1, args.max_retries) + 2):
                try:
                    client.table("pcon_boundaries").upsert(
                        batch,
                        on_conflict="pcon_code,pcon_version",
                        returning="minimal",
                    ).execute()
                    print(".", end="", flush=True)
                    break
                except Exception as exc:
                    if attempt >= max(1, args.max_retries) + 1:
                        print()
                        raise
                    print("!", end="", flush=True)
                    print(
                        f"\nRetrying batch (attempt {attempt}/{args.max_retries}) due to error: {exc}",
                        file=sys.stderr,
                    )
                    time.sleep(max(0.0, args.retry_backoff_seconds) * attempt)
            if args.sleep_seconds:
                time.sleep(max(0.0, args.sleep_seconds))
        print()

        print(f"Loaded {len(rows)} boundary rows (skipped {skipped}).")
    elif not (args.update_stations or args.update_history):
        if skip_due_to_exists:
            print("No boundary upload needed; existing version found.")
            return 0
        print("Nothing to do: use --update-stations/--update-history or remove --skip-boundaries.", file=sys.stderr)
        return 1

    def run_rpc(name: str, params: Dict[str, Any]) -> Any:
        for attempt in range(1, max(1, args.max_retries) + 2):
            try:
                response = client.rpc(name, params).execute()
                return response.data if hasattr(response, "data") else None
            except Exception:
                if attempt >= max(1, args.max_retries) + 1:
                    raise
                time.sleep(max(0.0, args.retry_backoff_seconds) * attempt)
        return None

    if args.update_stations:
        partitions = max(1, args.stations_partitions)
        if args.stations_partition_index is not None:
            if args.stations_partition_index < 0 or args.stations_partition_index >= partitions:
                print(
                    f"stations-partition-index must be between 0 and {partitions - 1}.",
                    file=sys.stderr,
                )
                return 1
            partition_indices = [args.stations_partition_index]
        else:
            partition_indices = list(range(partitions))

        if partitions == 1 and args.stations_partition_index is None:
            updated = run_rpc(
                "uk_aq_refresh_station_pcon_codes",
                {"target_version": args.pcon_version},
            )
            print(f"Updated stations with PCON codes: {updated}")
        else:
            total_updated = 0
            for idx in partition_indices:
                updated = run_rpc(
                    "uk_aq_refresh_station_pcon_codes_partition",
                    {
                        "target_version": args.pcon_version,
                        "partition_mod": partitions,
                        "partition_idx": idx,
                    },
                )
                if isinstance(updated, int):
                    total_updated += updated
                print(
                    f"Updated stations with PCON codes partition {idx + 1}/{partitions}: {updated}"
                )
                if args.sleep_seconds:
                    time.sleep(max(0.0, args.sleep_seconds))
            if len(partition_indices) > 1:
                print(f"Updated stations with PCON codes (total): {total_updated}")

    if args.update_history:
        partitions = max(1, args.history_partitions)
        if args.history_partition_index is not None:
            if args.history_partition_index < 0 or args.history_partition_index >= partitions:
                print(
                    f"history-partition-index must be between 0 and {partitions - 1}.",
                    file=sys.stderr,
                )
                return 1
            partition_indices = [args.history_partition_index]
        else:
            partition_indices = list(range(partitions))

        if partitions == 1 and args.history_partition_index is None:
            updated = run_rpc(
                "uk_aq_refresh_station_pcon_history",
                {"target_version": args.pcon_version},
            )
            print(f"Updated station PCON history: {updated}")
        else:
            for idx in partition_indices:
                updated = run_rpc(
                    "uk_aq_refresh_station_pcon_history_partition",
                    {
                        "target_version": args.pcon_version,
                        "partition_mod": partitions,
                        "partition_idx": idx,
                    },
                )
                print(
                    f"Updated station PCON history partition {idx + 1}/{partitions}: {updated}"
                )
                if args.sleep_seconds:
                    time.sleep(max(0.0, args.sleep_seconds))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
