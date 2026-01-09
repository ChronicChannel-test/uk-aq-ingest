#!/usr/bin/env python3
"""
Fetch UK-AIR SOS stations and filter to the UK bounding box.

Examples:
  python scripts/uk_aq_list_stations.py
  python scripts/uk_aq_list_stations.py --format csv --output uk_stations.csv
  python scripts/uk_aq_list_stations.py --no-filter
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

from ingest_helpers import station_coords, station_in_bbox_or_missing_coords
load_dotenv()

LOG = logging.getLogger("uk_aq_stations")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

UK_AIR_SOS_BASE_URL = (
    os.getenv("UK_AIR_SOS_BASE_URL")
    or os.getenv("UK_AIR_BASE_URL")
    or os.getenv("UKAIR_BASE_URL")
    or "https://uk-air.defra.gov.uk/sos-ukair/api/v1"
).rstrip("/")
UK_AIR_SOS_SERVICE_LABEL = (
    os.getenv("UK_AIR_SOS_SERVICE_LABEL")
    or os.getenv("UK_AIR_SERVICE_LABEL")
    or "UK-AIR-SOS"
)

UK_BBOX = {
    "west": -11.0,
    "south": 49.0,
    "east": 2.0,
    "north": 61.0,
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UkAirClient:
    def __init__(self, base_url: str = UK_AIR_SOS_BASE_URL, timeout: int = 60, retries: int = 3):
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

    def upsert_services(self, services: Iterable[Dict[str, Any]]) -> Dict[str, int]:
        payload_by_ref: Dict[str, Dict[str, Any]] = {}
        for svc in services:
            ref = svc.get("id")
            if ref is None:
                continue
            service_ref = str(ref)
            payload_by_ref[service_ref] = {
                "service_ref": service_ref,
                "label": _normalize_service_label(svc.get("label") or svc.get("name")),
                "service_url": svc.get("serviceUrl") or svc.get("url") or UK_AIR_SOS_BASE_URL,
            }
        payload = list(payload_by_ref.values())
        if payload:
            self.client.table("services").upsert(payload, on_conflict="service_ref").execute()
        return self.get_service_id_map(list(payload_by_ref.keys()))

    def get_service_id_map(self, service_refs: Sequence[str]) -> Dict[str, int]:
        mapping: Dict[str, int] = {}
        if not service_refs:
            return mapping
        resp = (
            self.client.table("services")
            .select("id,service_ref")
            .in_("service_ref", list(service_refs))
            .execute()
        )
        rows = resp.data if hasattr(resp, "data") else resp.get("data")
        for row in rows or []:
            mapping[str(row["service_ref"])] = int(row["id"])
        return mapping

    def upsert_reference_table(
        self,
        table: str,
        ref_key: str,
        items: Iterable[Dict[str, Any]],
        service_id: int,
    ) -> int:
        rows = []
        for item in items:
            ref = item.get("id") or item.get(ref_key)
            label = _item_label(item)
            if not ref or not label:
                continue
            rows.append(
                {
                    ref_key: str(ref),
                    "label": label,
                    "service_id": service_id,
                }
            )
        if rows:
            self.client.table(table).upsert(rows, on_conflict=f"service_id,{ref_key}").execute()
        return len(rows)

    def upsert_phenomena(self, items: Iterable[Dict[str, Any]], service_id: int) -> int:
        payload_by_uri: Dict[str, Dict[str, Any]] = {}
        for item in items:
            uri = item.get("eionet_uri") or item.get("id")
            label = _item_label(item)
            if not uri or not label:
                continue
            uri_value = str(uri)
            notation = item.get("notation")
            row = payload_by_uri.get(uri_value)
            if row is None:
                payload_by_uri[uri_value] = {
                    "eionet_uri": uri_value,
                    "label": label,
                    "notation": notation,
                    "service_id": service_id,
                }
                continue
            if label and (not row.get("label") or row.get("label") == uri_value):
                row["label"] = label
            if notation and not row.get("notation"):
                row["notation"] = notation
        rows = list(payload_by_uri.values())
        if rows:
            self.client.table("phenomena").upsert(rows, on_conflict="service_id,eionet_uri").execute()
        return len(rows)

    def upsert_stations(
        self,
        stations: Iterable[Dict[str, Any]],
        service_ref_map: Dict[str, int],
        seen_at: datetime,
        station_service_ref_map: Optional[Dict[str, str]] = None,
        default_service_ref: Optional[str] = None,
    ) -> int:
        seen_at_value = seen_at.isoformat()
        rows = []
        for station in stations:
            props = station.get("properties", {}) if isinstance(station.get("properties"), dict) else {}
            station_ref = station.get("id") or props.get("id")
            if not station_ref:
                continue
            lon, lat = station_coords(station, bbox=UK_BBOX)
            raw_service = station.get("service") or props.get("service")
            service_ref = None
            if isinstance(raw_service, dict):
                service_ref = raw_service.get("id")
            elif raw_service is not None:
                service_ref = str(raw_service)
            if station_service_ref_map:
                mapped = station_service_ref_map.get(str(station_ref))
                if mapped:
                    service_ref = mapped
            if not service_ref and default_service_ref:
                service_ref = default_service_ref
            if not service_ref:
                continue
            service_id = service_ref_map.get(str(service_ref))
            if not service_id:
                continue
            rows.append(
                {
                    "station_ref": str(station_ref),
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
            self.client.table("stations").upsert(rows, on_conflict="service_id,station_ref").execute()
        return len(rows)

    def mark_removed(self, seen_at: datetime, service_ids: Sequence[int]) -> None:
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


def _normalize_service_label(label: Optional[str]) -> Optional[str]:
    if label is None:
        return UK_AIR_SOS_SERVICE_LABEL
    trimmed = label.strip()
    if not trimmed:
        return UK_AIR_SOS_SERVICE_LABEL
    if trimmed.lower().startswith("my timeseries service"):
        return UK_AIR_SOS_SERVICE_LABEL
    return trimmed


def _item_label(item: Dict[str, Any]) -> Optional[str]:
    return (
        item.get("label")
        or item.get("name")
        or item.get("title")
        or item.get("notation")
        or item.get("eionet_uri")
    )


def _item_service_id(item: Dict[str, Any]) -> Optional[str]:
    service = item.get("service")
    if isinstance(service, dict):
        return service.get("id")
    if service is not None:
        return str(service)
    return None


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
    service_ref_map: Optional[Dict[str, str]] = None,
    default_service_ref: Optional[str] = None,
) -> Dict[str, Any]:
    props = station.get("properties", {}) if isinstance(station.get("properties"), dict) else {}
    lon, lat = station_coords(station, bbox=UK_BBOX)
    timeseries = props.get("timeseries") if isinstance(props.get("timeseries"), list) else []
    timeseries_ids = []
    for entry in timeseries:
        if isinstance(entry, dict):
            ts_id = entry.get("id")
            if ts_id:
                timeseries_ids.append(ts_id)
        elif entry is not None:
            timeseries_ids.append(str(entry))
    station_ref = station.get("id") or props.get("id")
    service_ref = _item_service_id(station) or _item_service_id(props)
    if service_ref_map and station_ref:
        mapped = service_ref_map.get(str(station_ref))
        if mapped:
            service_ref = mapped
    if not service_ref and default_service_ref:
        service_ref = default_service_ref
    return {
        "station_ref": station_ref,
        "label": station.get("label") or props.get("label") or station.get("name"),
        "station_type": props.get("stationType") or station.get("stationType"),
        "region": props.get("region") or station.get("region"),
        "longitude": lon,
        "latitude": lat,
        "service_ref": service_ref,
        "timeseries_refs": timeseries_ids or None,
    }


def _write_json(output: str, payload: Dict[str, Any]) -> None:
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def _write_csv(
    output: str,
    stations: Iterable[Dict[str, Any]],
    service_ref_map: Optional[Dict[str, str]] = None,
    default_service_ref: Optional[str] = None,
) -> None:
    rows = [
        _normalize_station(
            station, service_ref_map=service_ref_map, default_service_ref=default_service_ref
        )
        for station in stations
    ]
    fieldnames = [
        "station_ref",
        "label",
        "station_type",
        "region",
        "longitude",
        "latitude",
        "service_ref",
        "timeseries_refs",
    ]
    with open(output, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            if isinstance(row.get("timeseries_refs"), list):
                row["timeseries_refs"] = ",".join(str(val) for val in row["timeseries_refs"])
            writer.writerow(row)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch UK-AIR SOS stations for the UK.")
    parser.add_argument(
        "--output",
        default="uk_aq_stations.json",
        help="Output file path (default: uk_aq_stations.json).",
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
        "--service-ref-from-timeseries",
        "--service-id-from-timeseries",
        action="store_true",
        help="Resolve service_ref using timeseries metadata instead of defaulting to a single service.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    run_at = utcnow()
    client = UkAirClient()
    services = client.services()
    default_service_ref = None
    if len(services) == 1 and services[0].get("id"):
        default_service_ref = str(services[0].get("id"))
    stations = client.stations()
    if not stations:
        LOG.warning("No stations returned from UK-AIR SOS.")

    filtered = (
        stations
        if args.no_filter
        else [s for s in stations if station_in_bbox_or_missing_coords(s, UK_BBOX)]
    )
    missing_coords = sum(
        1
        for station in filtered
        if station_coords(station, bbox=UK_BBOX) == (None, None)
    )
    LOG.info(
        "Stations total=%s, uk_filtered=%s (missing coords=%s)",
        len(stations),
        len(filtered),
        missing_coords,
    )

    station_service_ref_map: Dict[str, str] = {}
    if args.service_ref_from_timeseries:
        station_ids = [
            s.get("id") or (s.get("properties") or {}).get("id")
            for s in filtered
            if s.get("id") or (s.get("properties") or {}).get("id")
        ]
        service_refs = [svc.get("id") for svc in services if svc.get("id")]
        station_service_ref_map = _station_service_map_from_timeseries(
            client, station_ids, service_refs, args.metadata_batch_size
        )
        LOG.info("Resolved service ref from timeseries for %s stations.", len(station_service_ref_map))

    if args.to_supabase:
        writer = SupabaseWriter()
        service_ref_map = writer.upsert_services(services)
        service_ids = list(service_ref_map.values())
        inserted = writer.upsert_stations(
            filtered,
            service_ref_map,
            run_at,
            station_service_ref_map=station_service_ref_map,
            default_service_ref=default_service_ref,
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
                series = client.timeseries(chunk, service_id=default_service_ref)
                for ts in series:
                    _collect_reference(phenomena, ts.get("phenomenon"))
                    _collect_reference(procedures, ts.get("procedure"))
                    _collect_reference(offerings, ts.get("offering"))
            if phenomena:
                LOG.info("Upserting phenomena: %s", len(phenomena))
                if service_id is not None:
                    writer.upsert_phenomena(phenomena.values(), service_id)
            if procedures:
                LOG.info("Upserting procedures: %s", len(procedures))
                if service_id is not None:
                    writer.upsert_reference_table("procedures", "procedure_ref", procedures.values(), service_id)
            if offerings:
                LOG.info("Upserting offerings: %s", len(offerings))
                if service_id is not None:
                    writer.upsert_reference_table("offerings", "offering_ref", offerings.values(), service_id)

    if args.format == "csv":
        _write_csv(
            args.output,
            filtered,
            service_ref_map=station_service_ref_map,
            default_service_ref=default_service_ref,
        )
    else:
        raw_payload = None
        if args.raw_output:
            raw_payload = {
                "source": UK_AIR_SOS_BASE_URL,
                "fetched_at": utcnow().isoformat(),
                "bbox": None if args.no_filter else UK_BBOX,
                "count": len(filtered),
                "stations": filtered,
            }
            _write_json(args.raw_output, raw_payload)
        payload = {
            "source": UK_AIR_SOS_BASE_URL,
            "fetched_at": utcnow().isoformat(),
            "bbox": None if args.no_filter else UK_BBOX,
            "count": len(filtered),
            "service_ref": default_service_ref,
            "stations": [
                _normalize_station(
                    station,
                    service_ref_map=station_service_ref_map,
                    default_service_ref=default_service_ref,
                )
                for station in filtered
            ],
        }
        _write_json(args.output, payload)
    LOG.info("Wrote %s", args.output)


if __name__ == "__main__":
    main()
