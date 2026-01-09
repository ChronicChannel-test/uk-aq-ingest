#!/usr/bin/env python3
"""
Load Local Authority boundaries into Supabase for station-to-LA mapping.

Requires:
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY

The GeoJSON file should contain Polygon or MultiPolygon geometries and
properties for LA code/name fields.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
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
    parser = argparse.ArgumentParser(description="Load LA boundaries into Supabase.")
    parser.add_argument("--geojson", required=True, help="Path to a GeoJSON boundary file.")
    parser.add_argument("--la-version", required=True, help="Boundary dataset version (e.g., 2023).")
    parser.add_argument("--code-field", default="la_code", help="GeoJSON property for LA code.")
    parser.add_argument("--name-field", default="la_name", help="GeoJSON property for LA name.")
    parser.add_argument("--batch-size", type=int, default=200, help="Rows per upsert batch.")
    parser.add_argument(
        "--update-stations",
        action="store_true",
        help="Update stations with LA codes after loading boundaries.",
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

    rows: List[Dict[str, Any]] = []
    skipped = 0
    for feature in features:
        geometry = feature.get("geometry") if isinstance(feature, dict) else None
        props = feature.get("properties") if isinstance(feature, dict) else None
        if not geometry or not props:
            skipped += 1
            continue
        la_code = props.get(args.code_field)
        if not la_code:
            skipped += 1
            continue
        wkt = geometry_to_wkt(geometry)
        if not wkt:
            skipped += 1
            continue
        rows.append(
            {
                "la_code": str(la_code),
                "la_name": props.get(args.name_field),
                "la_version": args.la_version,
                "geometry": f"SRID=4326;{wkt}",
            }
        )

    if not rows:
        print("No boundaries parsed from the GeoJSON file.", file=sys.stderr)
        return 1

    client = create_client(supabase_url, service_role_key)
    for batch in chunked(rows, max(1, args.batch_size)):
        client.table("la_boundaries").upsert(batch, on_conflict="la_code,la_version").execute()

    print(f"Loaded {len(rows)} boundary rows (skipped {skipped}).")

    if args.update_stations:
        response = client.rpc(
            "uk_aq_refresh_station_la_codes",
            {"target_version": args.la_version},
        ).execute()
        updated = response.data if hasattr(response, "data") else None
        print(f"Updated stations with LA codes: {updated}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
