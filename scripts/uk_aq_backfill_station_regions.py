#!/usr/bin/env python3
"""
Backfill stations.region using OS Open Names GB GPKG lookups.
"""

from __future__ import annotations

import argparse
import os
from typing import Any, Dict, List, Optional, Sequence

from dotenv import load_dotenv
from supabase import create_client

from uk_aq_enrich_station_names import (
    NI_BBOX,
    OpenNamesLookup,
    _ensure_gb_gpkg,
    _in_bbox,
    _parse_geometry_coords,
)

load_dotenv()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill stations.region using OS Open Names GB lookups."
    )
    parser.add_argument("--limit", type=int, default=0, help="Max stations to process (0 = no limit).")
    parser.add_argument("--page-size", type=int, default=1000, help="Supabase page size (default: 1000).")
    parser.add_argument(
        "--gb-search-radius-m",
        type=float,
        default=5000.0,
        help="Search radius in meters for OS Open Names lookups (default: 5000).",
    )
    parser.add_argument(
        "--max-distance-m",
        type=float,
        default=None,
        help="Optional max distance in meters for region matches.",
    )
    parser.add_argument(
        "--gb-gpkg-path",
        default=None,
        help="Path to the OS Open Names GB GPKG (defaults to the enrich script setting).",
    )
    parser.add_argument(
        "--gb-gpkg-dropbox-path",
        default=None,
        help="Dropbox path for the GB GPKG (optional).",
    )
    parser.add_argument(
        "--download-gb-gpkg",
        action="store_true",
        help="Download the GB GPKG from Dropbox if missing.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write region updates back to Supabase.",
    )
    parser.add_argument(
        "--apply-batch-size",
        type=int,
        default=200,
        help="Batch size for region updates (default: 200).",
    )
    return parser.parse_args()


def _fetch_stations(page_size: int) -> List[Dict[str, Any]]:
    supabase_url = os.getenv("SUPABASE_URL")
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_role_key:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")
    client = create_client(supabase_url, service_role_key)
    rows: List[Dict[str, Any]] = []
    offset = 0
    while True:
        response = (
            client.table("stations")
            .select("id,station_ref,label,region,geometry")
            .is_("region", "null")
            .order("id")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        batch = response.data if hasattr(response, "data") else response.get("data")
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
    return rows


def _resolve_region(matches: Sequence[Dict[str, Any]], max_distance_m: Optional[float]) -> Optional[str]:
    for match in matches:
        region = match.get("region")
        if not region:
            continue
        distance = match.get("distance_m")
        if max_distance_m is not None and distance is not None:
            try:
                if float(distance) > max_distance_m:
                    continue
            except (TypeError, ValueError):
                pass
        return str(region)
    return None


def _apply_updates(updates: List[Dict[str, Any]], batch_size: int) -> int:
    if not updates:
        return 0
    supabase_url = os.getenv("SUPABASE_URL")
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_role_key:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")
    client = create_client(supabase_url, service_role_key)
    applied = 0
    for update in updates:
        station_id = update.get("id")
        region = update.get("region")
        if station_id is None or not region:
            continue
        response = (
            client.table("stations")
            .update({"region": region})
            .eq("id", station_id)
            .execute()
        )
        error = getattr(response, "error", None)
        if error:
            raise RuntimeError(f"Region update failed for id={station_id}: {error}")
        data = getattr(response, "data", None) or []
        if not data:
            continue
        applied += 1
        if applied % max(1, batch_size) == 0:
            pass
    return applied


def main() -> int:
    args = parse_args()
    gb_path = _ensure_gb_gpkg(args)
    gb_lookup = OpenNamesLookup(gb_path)

    stations = _fetch_stations(args.page_size)
    processed = 0
    updates: List[Dict[str, Any]] = []
    for station in stations:
        if args.limit and processed >= args.limit:
            break
        coords = _parse_geometry_coords(station.get("geometry"))
        if coords is None:
            continue
        lon, lat = coords
        if _in_bbox(lon, lat, NI_BBOX):
            continue
        matches = gb_lookup.nearest_matches(
            lon,
            lat,
            limit=5,
            search_radius_m=args.gb_search_radius_m,
            max_candidates=None,
        )
        region = _resolve_region(matches, args.max_distance_m)
        if region:
            updates.append({"id": station.get("id"), "region": region})
        processed += 1

    gb_lookup.close()

    print(f"Stations scanned={processed}, region updates proposed={len(updates)}")
    if args.apply:
        applied = _apply_updates(updates, args.apply_batch_size)
        print(f"Region updates applied={applied}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
