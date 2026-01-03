#!/usr/bin/env python3
"""
Fetch UK-AIR SOS stations and filter to the UK bounding box.

Examples:
  python scripts/uk_air_list_stations.py
  python scripts/uk_air_list_stations.py --format csv --output uk_stations.csv
  python scripts/uk_air_list_stations.py --no-filter
"""

import argparse
import csv
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import requests
from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv()

LOG = logging.getLogger("uk_air_stations")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

UK_AIR_BASE_URL = (
    os.getenv("UK_AIR_BASE_URL")
    or os.getenv("UKAIR_BASE_URL")
    or "https://uk-air.defra.gov.uk/sos-ukair/api/v1"
).rstrip("/")

UK_BBOX = {
    "west": -11.0,
    "south": 49.0,
    "east": 2.0,
    "north": 61.0,
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UkAirClient:
    def __init__(self, base_url: str = UK_AIR_BASE_URL, timeout: int = 60, retries: int = 3):
        self.base_url = base_url
        self.timeout = timeout
        self.retries = retries
        self.session = requests.Session()

    def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        url = f"{self.base_url}/{path.lstrip('/')}"
        for attempt in range(1, self.retries + 1):
            try:
                resp = self.session.get(url, params=params, timeout=self.timeout)
                if resp.status_code in (429, 500, 502, 503, 504):
                    self._sleep(attempt)
                    continue
                resp.raise_for_status()
                return resp.json()
            except requests.RequestException as exc:
                LOG.warning("Request failed (attempt %s/%s): %s", attempt, self.retries, exc)
                if attempt == self.retries:
                    raise
                self._sleep(attempt)
        return []

    def _sleep(self, attempt: int) -> None:
        delay = min(30, 2**attempt)
        time.sleep(delay)

    def stations(self) -> List[Dict[str, Any]]:
        params_options: List[Optional[Dict[str, Any]]] = [{"expanded": "true"}, None]
        last_error: Optional[Exception] = None
        for params in params_options:
            try:
                data = self.get("/stations", params=params)
                stations = _extract_list(data, ("stations", "data"))
                if stations:
                    LOG.info("Fetched %s stations using params=%s", len(stations), params or {})
                return stations
            except requests.HTTPError as exc:
                if exc.response is not None and exc.response.status_code == 400:
                    LOG.warning("Stations query failed (400) with params=%s; trying fallback.", params)
                    last_error = exc
                    continue
                raise
        if last_error is not None:
            raise last_error
        return []

    def services(self) -> List[Dict[str, Any]]:
        data = self.get("/services")
        return _extract_list(data, ("services", "data"))

    def timeseries(
        self, station_ids: Sequence[str], service_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        if not station_ids:
            return []
        params: Dict[str, Any] = {"expanded": "true", "station": list(station_ids)}
        if service_id:
            params["service"] = service_id
        try:
            data = self.get("/timeseries", params=params)
            return _extract_list(data, ("timeseries", "data"))
        except requests.HTTPError as exc:
            if exc.response is not None and exc.response.status_code == 400 and service_id:
                params.pop("service", None)
                data = self.get("/timeseries", params=params)
                return _extract_list(data, ("timeseries", "data"))
            raise


class SupabaseWriter:
    def __init__(self) -> None:
        supabase_url = os.getenv("SUPABASE_URL")
        supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if not supabase_url or not supabase_key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")
        self.client: Client = create_client(supabase_url, supabase_key)

    def upsert_services(self, services: Iterable[Dict[str, Any]]) -> List[str]:
        payload = [
            {
                "id": svc.get("id"),
                "label": svc.get("label") or svc.get("name"),
                "service_url": svc.get("serviceUrl") or svc.get("url"),
                "version": svc.get("version"),
                "type": svc.get("type"),
                "supports_first_latest": svc.get("supportsFirstLatest"),
                "quantities": svc.get("quantities"),
            }
            for svc in services
            if svc.get("id")
        ]
        if payload:
            self.client.table("services").upsert(payload, on_conflict="id").execute()
        return [svc["id"] for svc in payload]

    def upsert_reference_table(self, table: str, items: Iterable[Dict[str, Any]]) -> int:
        rows = []
        for item in items:
            item_id = item.get("id")
            label = _item_label(item)
            if not item_id or not label:
                continue
            rows.append(
                {
                    "id": item_id,
                    "label": label,
                    "service_id": _item_service_id(item),
                }
            )
        if rows:
            self.client.table(table).upsert(rows, on_conflict="id").execute()
        return len(rows)

    def upsert_stations(
        self,
        stations: Iterable[Dict[str, Any]],
        service_ids: Sequence[str],
        seen_at: datetime,
        service_id_map: Optional[Dict[str, str]] = None,
    ) -> int:
        service_id_set = set(service_ids)
        seen_at_value = seen_at.isoformat()
        rows = []
        for station in stations:
            props = station.get("properties", {}) if isinstance(station.get("properties"), dict) else {}
            station_id = station.get("id") or props.get("id")
            if not station_id:
                continue
            lon, lat = _station_coords(station, bbox=UK_BBOX)
            raw_service = station.get("service") or props.get("service")
            service_id = None
            if isinstance(raw_service, dict):
                service_id = raw_service.get("id")
            elif raw_service is not None:
                service_id = str(raw_service)
            if service_id_map:
                mapped = service_id_map.get(str(station_id))
                if mapped:
                    service_id = mapped
            if service_id not in service_id_set:
                service_id = service_ids[0] if len(service_ids) == 1 else None
            if not service_id:
                continue
            rows.append(
                {
                    "id": station_id,
                    "label": station.get("label") or props.get("label") or station.get("name"),
                    "station_type": props.get("stationType") or station.get("stationType"),
                    "region": props.get("region") or station.get("region"),
                    "geometry": f"SRID=4326;POINT({lon} {lat})" if lon is not None and lat is not None else None,
                    "service_id": service_id,
                    "last_seen_at": seen_at_value,
                    "removed_at": None,
                }
            )
        if rows:
            self.client.table("stations").upsert(rows, on_conflict="id,service_id").execute()
        return len(rows)

    def mark_removed(self, seen_at: datetime, service_ids: Sequence[str]) -> None:
        if not service_ids:
            return
        seen_at_value = seen_at.isoformat()
        self.client.table("stations").update({"removed_at": seen_at_value}).in_(
            "service_id", list(service_ids)
        ).is_("removed_at", "null").lt("last_seen_at", seen_at_value).execute()


def _extract_list(payload: Any, keys: Sequence[str]) -> List[Dict[str, Any]]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in keys:
            items = payload.get(key)
            if isinstance(items, list):
                return items
    return []


def _coerce_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _item_label(item: Dict[str, Any]) -> Optional[str]:
    return item.get("label") or item.get("name") or item.get("title")


def _item_service_id(item: Dict[str, Any]) -> Optional[str]:
    service = item.get("service")
    if isinstance(service, dict):
        return service.get("id")
    if service is not None:
        return str(service)
    return None


def _maybe_swap_coords(
    lon: Optional[float], lat: Optional[float], bbox: Optional[Dict[str, float]]
) -> Tuple[Optional[float], Optional[float]]:
    if lon is None or lat is None or bbox is None:
        return lon, lat
    # If the values look swapped for the target bbox, swap them.
    if (
        bbox["south"] <= lon <= bbox["north"]
        and bbox["west"] <= lat <= bbox["east"]
        and not (bbox["west"] <= lon <= bbox["east"])
        and not (bbox["south"] <= lat <= bbox["north"])
    ):
        return lat, lon
    return lon, lat


def _station_coords(
    station: Dict[str, Any], bbox: Optional[Dict[str, float]] = None
) -> Tuple[Optional[float], Optional[float]]:
    coords = None
    geometry = station.get("geometry")
    if isinstance(geometry, dict):
        coords = geometry.get("coordinates")
    if coords is None:
        props = station.get("properties", {}) if isinstance(station.get("properties"), dict) else {}
        geometry = props.get("geometry")
        if isinstance(geometry, dict):
            coords = geometry.get("coordinates")
    if coords and len(coords) >= 2:
        lon = _coerce_float(coords[0])
        lat = _coerce_float(coords[1])
        lon, lat = _maybe_swap_coords(lon, lat, bbox)
        return lon, lat

    props = station.get("properties", {}) if isinstance(station.get("properties"), dict) else {}
    lon = _coerce_float(props.get("longitude") or props.get("lon") or props.get("lng"))
    lat = _coerce_float(props.get("latitude") or props.get("lat"))
    lon, lat = _maybe_swap_coords(lon, lat, bbox)
    return lon, lat


def _station_in_bbox(station: Dict[str, Any], bbox: Dict[str, float]) -> bool:
    lon, lat = _station_coords(station, bbox=bbox)
    if lon is None or lat is None:
        return False
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        return False
    return bbox["west"] <= lon <= bbox["east"] and bbox["south"] <= lat <= bbox["north"]


def _station_in_bbox_or_missing_coords(station: Dict[str, Any], bbox: Dict[str, float]) -> bool:
    lon, lat = _station_coords(station, bbox=bbox)
    if lon is None or lat is None:
        return True
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        return False
    return bbox["west"] <= lon <= bbox["east"] and bbox["south"] <= lat <= bbox["north"]


def _collect_reference(store: Dict[str, Dict[str, Any]], item: Any) -> None:
    if not isinstance(item, dict):
        return
    item_id = item.get("id")
    label = _item_label(item)
    if not item_id or not label:
        return
    store[item_id] = item


def _chunked(values: Sequence[str], size: int) -> Iterable[Sequence[str]]:
    if size <= 0:
        size = 50
    for idx in range(0, len(values), size):
        yield values[idx : idx + size]


def _station_service_map_from_timeseries(
    client: UkAirClient,
    station_ids: Sequence[str],
    service_ids: Sequence[str],
    batch_size: int,
) -> Dict[str, str]:
    mapping: Dict[str, str] = {}
    if not station_ids:
        return mapping
    service_list = list(service_ids) if service_ids else [None]
    for chunk in _chunked(list(station_ids), batch_size):
        for service_id in service_list:
            series = client.timeseries(chunk, service_id=service_id)
            for ts in series:
                station = ts.get("station")
                if isinstance(station, dict):
                    station_id = station.get("id")
                else:
                    station_id = station
                service = ts.get("service")
                if isinstance(service, dict):
                    svc_id = service.get("id")
                else:
                    svc_id = service
                if not station_id or not svc_id:
                    continue
                station_key = str(station_id)
                svc_key = str(svc_id)
                if station_key in mapping and mapping[station_key] != svc_key:
                    LOG.warning(
                        "Station %s maps to multiple services (%s, %s)",
                        station_key,
                        mapping[station_key],
                        svc_key,
                    )
                    continue
                mapping[station_key] = svc_key
    return mapping


def _normalize_station(
    station: Dict[str, Any],
    service_id_map: Optional[Dict[str, str]] = None,
    default_service_id: Optional[str] = None,
) -> Dict[str, Any]:
    props = station.get("properties", {}) if isinstance(station.get("properties"), dict) else {}
    lon, lat = _station_coords(station, bbox=UK_BBOX)
    timeseries = props.get("timeseries") if isinstance(props.get("timeseries"), list) else []
    timeseries_ids = []
    for entry in timeseries:
        if isinstance(entry, dict):
            ts_id = entry.get("id")
            if ts_id:
                timeseries_ids.append(ts_id)
        elif entry is not None:
            timeseries_ids.append(str(entry))
    station_id = station.get("id") or props.get("id")
    service_id = _item_service_id(station) or _item_service_id(props)
    if service_id_map and station_id:
        mapped = service_id_map.get(str(station_id))
        if mapped:
            service_id = mapped
    if not service_id and default_service_id:
        service_id = default_service_id
    return {
        "id": station_id,
        "label": station.get("label") or props.get("label") or station.get("name"),
        "station_type": props.get("stationType") or station.get("stationType"),
        "region": props.get("region") or station.get("region"),
        "longitude": lon,
        "latitude": lat,
        "service_id": service_id,
        "timeseries_ids": timeseries_ids or None,
    }


def _write_json(output: str, payload: Dict[str, Any]) -> None:
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def _write_csv(
    output: str,
    stations: Iterable[Dict[str, Any]],
    service_id_map: Optional[Dict[str, str]] = None,
    default_service_id: Optional[str] = None,
) -> None:
    rows = [
        _normalize_station(
            station, service_id_map=service_id_map, default_service_id=default_service_id
        )
        for station in stations
    ]
    fieldnames = [
        "id",
        "label",
        "station_type",
        "region",
        "longitude",
        "latitude",
        "service_id",
        "timeseries_ids",
    ]
    with open(output, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            if isinstance(row.get("timeseries_ids"), list):
                row["timeseries_ids"] = ",".join(str(val) for val in row["timeseries_ids"])
            writer.writerow(row)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch UK-AIR SOS stations for the UK.")
    parser.add_argument(
        "--output",
        default="uk_air_stations.json",
        help="Output file path (default: uk_air_stations.json).",
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
        "--skip-metadata",
        action="store_true",
        help="Skip phenomena/procedures/offerings upserts when writing to Supabase.",
    )
    parser.add_argument(
        "--metadata-batch-size",
        type=int,
        default=50,
        help="Batch size for timeseries metadata requests (default: 50).",
    )
    parser.add_argument(
        "--service-id-from-timeseries",
        action="store_true",
        help="Resolve service_id using timeseries metadata instead of defaulting to a single service.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    run_at = utcnow()
    client = UkAirClient()
    services = client.services()
    default_service_id = None
    if len(services) == 1 and services[0].get("id"):
        default_service_id = str(services[0].get("id"))
    stations = client.stations()
    if not stations:
        LOG.warning("No stations returned from UK-AIR SOS.")

    filtered = (
        stations
        if args.no_filter
        else [s for s in stations if _station_in_bbox_or_missing_coords(s, UK_BBOX)]
    )
    missing_coords = sum(
        1
        for station in filtered
        if _station_coords(station, bbox=UK_BBOX) == (None, None)
    )
    LOG.info(
        "Stations total=%s, uk_filtered=%s (missing coords=%s)",
        len(stations),
        len(filtered),
        missing_coords,
    )

    service_id_map: Dict[str, str] = {}
    if args.service_id_from_timeseries:
        station_ids = [
            s.get("id") or (s.get("properties") or {}).get("id")
            for s in filtered
            if s.get("id") or (s.get("properties") or {}).get("id")
        ]
        service_ids = [svc.get("id") for svc in services if svc.get("id")]
        service_id_map = _station_service_map_from_timeseries(
            client, station_ids, service_ids, args.metadata_batch_size
        )
        LOG.info("Resolved service_id from timeseries for %s stations.", len(service_id_map))

    if args.to_supabase:
        writer = SupabaseWriter()
        service_ids = writer.upsert_services(services)
        inserted = writer.upsert_stations(
            filtered, service_ids, run_at, service_id_map=service_id_map
        )
        LOG.info("Upserted %s stations into Supabase.", inserted)
        writer.mark_removed(run_at, service_ids)

        if not args.skip_metadata:
            station_ids = [
                s.get("id") or (s.get("properties") or {}).get("id")
                for s in filtered
                if s.get("id") or (s.get("properties") or {}).get("id")
            ]
            service_id = service_ids[0] if service_ids else None
            phenomena: Dict[str, Dict[str, Any]] = {}
            procedures: Dict[str, Dict[str, Any]] = {}
            offerings: Dict[str, Dict[str, Any]] = {}
            for chunk in _chunked(station_ids, args.metadata_batch_size):
                series = client.timeseries(chunk, service_id=service_id)
                for ts in series:
                    _collect_reference(phenomena, ts.get("phenomenon"))
                    _collect_reference(procedures, ts.get("procedure"))
                    _collect_reference(offerings, ts.get("offering"))
            if phenomena:
                LOG.info("Upserting phenomena: %s", len(phenomena))
                writer.upsert_reference_table("phenomena", phenomena.values())
            if procedures:
                LOG.info("Upserting procedures: %s", len(procedures))
                writer.upsert_reference_table("procedures", procedures.values())
            if offerings:
                LOG.info("Upserting offerings: %s", len(offerings))
                writer.upsert_reference_table("offerings", offerings.values())

    if args.format == "csv":
        _write_csv(
            args.output,
            filtered,
            service_id_map=service_id_map,
            default_service_id=default_service_id,
        )
    else:
        raw_payload = None
        if args.raw_output:
            raw_payload = {
                "source": UK_AIR_BASE_URL,
                "fetched_at": utcnow().isoformat(),
                "bbox": None if args.no_filter else UK_BBOX,
                "count": len(filtered),
                "stations": filtered,
            }
            _write_json(args.raw_output, raw_payload)
        payload = {
            "source": UK_AIR_BASE_URL,
            "fetched_at": utcnow().isoformat(),
            "bbox": None if args.no_filter else UK_BBOX,
            "count": len(filtered),
            "service_id": default_service_id,
            "stations": [
                _normalize_station(
                    station,
                    service_id_map=service_id_map,
                    default_service_id=default_service_id,
                )
                for station in filtered
            ],
        }
        _write_json(args.output, payload)
    LOG.info("Wrote %s", args.output)


if __name__ == "__main__":
    main()
