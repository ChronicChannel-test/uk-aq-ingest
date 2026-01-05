#!/usr/bin/env python3
"""
UK-AIR SOS ingestion helper.

This script:
1) Discovers SOS metadata (services, stations, timeseries) for a filtered set of stations.
2) Backfills observations for a chosen year.
3) Supports incremental refreshes for the last N hours (default 6h).

Environment:
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- UK_AIR_SOS_BASE_URL (optional; defaults to https://uk-air.defra.gov.uk/sos-ukair/api/v1)
- UK_AIR_SOS_SERVICE_LABEL (optional; defaults to UK-AIR-SOS)
- services.poll_timeseries_batch_size (optional; overrides default batch size)
- services.stations_bbox_supported (optional; when false, skip bbox for station discovery)
- services.timeseries_station_filter_supported (optional; when false, skip station filtering for timeseries)

Examples:
  python scripts/uk_air_sos_ingest.py --discover --backfill-2025
  python scripts/uk_air_sos_ingest.py --refresh-recent --hours 6
"""

import argparse
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set

import requests
from dotenv import load_dotenv
from supabase import Client, create_client

from ingest_helpers import station_in_bbox, station_in_bbox_or_missing_coords
load_dotenv()

LOG = logging.getLogger("uk_air_sos")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

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
DEFAULT_POLLUTANTS = {"no2", "o3", "pm10", "pm2.5"}
EIONET_POLLUTANT_RE = re.compile(r"https?://dd\.eionet\.europa\.eu/vocabulary/aq/pollutant/\d+")
DEFAULT_TIMESERIES_STATION_BATCH_SIZE = 50


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UkAirClient:
    def __init__(self, base_url: str = UK_AIR_SOS_BASE_URL, timeout: int = 60, retries: int = 3):
        self.base_url = base_url
        self.timeout = timeout
        self.retries = retries
        self.session = requests.Session()

    def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{self.base_url}/{path.lstrip('/')}"
        for attempt in range(1, self.retries + 1):
            try:
                resp = self.session.get(url, params=params, timeout=self.timeout)
                if resp.status_code in (429, 500, 502, 503, 504):
                    self._sleep(attempt)
                    continue
                resp.raise_for_status()
                return resp.json()
            except requests.HTTPError as exc:
                status = exc.response.status_code if exc.response is not None else "unknown"
                level = logging.INFO if status == 400 else logging.WARNING
                LOG.log(
                    level,
                    "Request failed (attempt %s/%s): HTTP %s %s",
                    attempt,
                    self.retries,
                    status,
                    self._request_label(path, params),
                )
                if attempt == self.retries:
                    raise
                self._sleep(attempt)
            except requests.RequestException as exc:
                LOG.warning(
                    "Request failed (attempt %s/%s): %s",
                    attempt,
                    self.retries,
                    exc,
                )
                if attempt == self.retries:
                    raise
                self._sleep(attempt)
        return {}

    def _sleep(self, attempt: int) -> None:
        delay = min(30, 2**attempt)
        time.sleep(delay)

    def _request_label(self, path: str, params: Optional[Dict[str, Any]]) -> str:
        if not params:
            return path
        station_list = params.get("station") if isinstance(params, dict) else None
        if isinstance(station_list, list):
            return f"{path} (stations={len(station_list)})"
        return f"{path} (params={','.join(sorted(params.keys()))})"

    def services(self) -> List[Dict[str, Any]]:
        data = self.get("/services")
        return _extract_list(data, ("services", "data"))

    def stations(
        self,
        service_id: str,
        bbox: Optional[Dict[str, float]] = None,
        region: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        bbox_param = None
        if bbox:
            bbox_param = f"{bbox['west']},{bbox['south']},{bbox['east']},{bbox['north']}"
        params_options: List[Dict[str, Any]] = []

        def add_param_sets(expanded: Optional[str]) -> None:
            base = {"service": service_id}
            if expanded:
                base["expanded"] = expanded
            if bbox_param and region:
                params_options.append({**base, "bbox": bbox_param, "region": region})
            if bbox_param:
                params_options.append({**base, "bbox": bbox_param})
            if region:
                params_options.append({**base, "region": region})
            params_options.append(base.copy())
            if bbox_param:
                params_options.append({"bbox": bbox_param, **({"expanded": expanded} if expanded else {})})
            if region:
                params_options.append({"region": region, **({"expanded": expanded} if expanded else {})})
            if expanded:
                params_options.append({"expanded": expanded})
            params_options.append({})

        add_param_sets("true")
        add_param_sets(None)

        seen = set()
        skip_bbox = False
        for params in params_options:
            key = tuple(sorted(params.items()))
            if key in seen:
                continue
            seen.add(key)
            if skip_bbox and "bbox" in params:
                continue
            try:
                data = self.get("/stations", params=params or None)
                LOG.info("Station query succeeded with params: %s", params or {})
                return _extract_list(data, ("stations", "data"))
            except requests.HTTPError as exc:
                if exc.response is not None and exc.response.status_code == 400:
                    if "bbox" in params:
                        skip_bbox = True
                    LOG.info("Station query failed (400) with params %s; trying fallback.", params)
                    continue
                raise
        return []

    def timeseries(
        self,
        service_id: str,
        station_ids: Optional[Sequence[str]],
        batch_size: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        series: List[Dict[str, Any]] = []
        if station_ids is None:
            LOG.info("Fetching timeseries without station filter")
            data = self.get("/timeseries", params={"service": service_id, "expanded": "true"})
            series.extend(_extract_list(data, ("timeseries", "data")))
        else:
            if not station_ids:
                return series
            size = batch_size or DEFAULT_TIMESERIES_STATION_BATCH_SIZE
            if size <= 0:
                size = DEFAULT_TIMESERIES_STATION_BATCH_SIZE
            LOG.info("Fetching timeseries for %s stations in batches of %s", len(station_ids), size)
            for chunk in _chunked(station_ids, size):
                params: Dict[str, Any] = {"service": service_id, "expanded": "true"}
                for station_id in chunk:
                    params.setdefault("station", []).append(station_id)
                data = self.get("/timeseries", params=params)
                series.extend(_extract_list(data, ("timeseries", "data")))
        return _dedupe_by_id(series)

    def timeseries_data(
        self, series_id: str, timespan: str, format_: str = "tvp"
    ) -> Dict[str, Any]:
        params = {"timespan": timespan, "format": format_}
        return self.get(f"/timeseries/{series_id}/getData", params=params)


class SupabaseWriter:
    def __init__(self) -> None:
        supabase_url = os.getenv("SUPABASE_URL")
        supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if not supabase_url or not supabase_key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")
        self.client: Client = create_client(supabase_url, supabase_key)

    def upsert_services(self, services: Iterable[Dict[str, Any]]) -> None:
        payload = [
            {
                "id": svc.get("id"),
                "label": _normalize_service_label(svc.get("label") or svc.get("name")),
                "service_url": svc.get("serviceUrl") or svc.get("url") or UK_AIR_SOS_BASE_URL,
            }
            for svc in services
            if svc.get("id")
        ]
        if payload:
            self.client.table("services").upsert(payload, on_conflict="id").execute()

    def get_service_settings(self, service_id: str) -> Dict[str, Optional[object]]:
        try:
            resp = (
                self.client.table("services")
                .select("poll_timeseries_batch_size,stations_bbox_supported,timeseries_station_filter_supported")
                .eq("id", service_id)
                .execute()
            )
        except Exception as exc:
            LOG.warning("Failed to read services settings: %s", exc)
            return {
                "poll_timeseries_batch_size": None,
                "stations_bbox_supported": None,
                "timeseries_station_filter_supported": None,
            }
        data = resp.data if hasattr(resp, "data") else resp.get("data")
        if not data:
            return {
                "poll_timeseries_batch_size": None,
                "stations_bbox_supported": None,
                "timeseries_station_filter_supported": None,
            }
        row = data[0] if isinstance(data, list) else data
        if not isinstance(row, dict):
            return {
                "poll_timeseries_batch_size": None,
                "stations_bbox_supported": None,
                "timeseries_station_filter_supported": None,
            }
        batch_size = row.get("poll_timeseries_batch_size")
        bbox_supported = row.get("stations_bbox_supported")
        station_filter_supported = row.get("timeseries_station_filter_supported")
        try:
            batch_int = int(batch_size)
        except (TypeError, ValueError):
            batch_int = None
        if batch_int is not None and batch_int <= 0:
            batch_int = None
        if isinstance(bbox_supported, str):
            bbox_supported = bbox_supported.strip().lower() in {"true", "1", "yes"}
        if not isinstance(bbox_supported, bool):
            bbox_supported = None
        if isinstance(station_filter_supported, str):
            station_filter_supported = station_filter_supported.strip().lower() in {"true", "1", "yes"}
        if not isinstance(station_filter_supported, bool):
            station_filter_supported = None
        return {
            "poll_timeseries_batch_size": batch_int,
            "stations_bbox_supported": bbox_supported,
            "timeseries_station_filter_supported": station_filter_supported,
        }

    def upsert_reference_table(self, table: str, items: Iterable[Dict[str, Any]]) -> None:
        payload_by_id: Dict[str, Dict[str, Any]] = {}
        for item in items:
            if not item or not isinstance(item, dict):
                continue
            item_id = item.get("id")
            if not item_id:
                continue
            label = (
                item.get("label")
                or item.get("notation")
                or item.get("eionet_uri")
                or item_id
            )
            row = {"id": item_id, "label": label, "service_id": item.get("service", {}).get("id")}
            if table == "phenomena":
                row["eionet_uri"] = item.get("eionet_uri")
                row["notation"] = item.get("notation")
            existing = payload_by_id.get(item_id)
            if existing:
                if not existing.get("label") and row.get("label"):
                    existing["label"] = row.get("label")
                if not existing.get("service_id") and row.get("service_id"):
                    existing["service_id"] = row.get("service_id")
                if table == "phenomena":
                    if not existing.get("eionet_uri") and row.get("eionet_uri"):
                        existing["eionet_uri"] = row.get("eionet_uri")
                    if not existing.get("notation") and row.get("notation"):
                        existing["notation"] = row.get("notation")
            else:
                payload_by_id[item_id] = row
        payload = list(payload_by_id.values())
        if payload:
            self.client.table(table).upsert(payload, on_conflict="id").execute()

    def upsert_stations(self, stations: Iterable[Dict[str, Any]], service_id: str) -> None:
        rows = []
        for station in stations:
            coords = (
                station.get("geometry", {}).get("coordinates")
                if isinstance(station.get("geometry"), dict)
                else None
            )
            lon, lat = (coords or [None, None])[:2]
            props = station.get("properties", {})
            station_id = station.get("id") or props.get("id")
            if not station_id:
                continue
            rows.append(
                {
                    "source_id": station_id,
                    "label": station.get("label") or props.get("label"),
                    "station_type": props.get("stationType") or station.get("stationType"),
                    "region": props.get("region") or station.get("region"),
                    "geometry": f"SRID=4326;POINT({lon} {lat})" if lon is not None and lat is not None else None,
                    "service_id": service_id,
                    "category_id": props.get("category", {}).get("id") if isinstance(props.get("category"), dict) else None,
                }
            )
        if rows:
            self.client.table("stations").upsert(rows, on_conflict="service_id,source_id").execute()

    def upsert_timeseries(
        self,
        series: Iterable[Dict[str, Any]],
        default_service_id: Optional[str],
        station_id_map: Dict[str, int],
    ) -> None:
        rows = []
        for ts in series:
            station_source_id = (
                ts.get("station", {}).get("id")
                if isinstance(ts.get("station"), dict)
                else ts.get("station")
            )
            station_db_id = station_id_map.get(str(station_source_id)) if station_source_id is not None else None
            phenomenon_id = ts.get("phenomenon", {}).get("id") if isinstance(ts.get("phenomenon"), dict) else None
            procedure_id = ts.get("procedure", {}).get("id") if isinstance(ts.get("procedure"), dict) else None
            offering_id = ts.get("offering", {}).get("id") if isinstance(ts.get("offering"), dict) else None
            feature_id = ts.get("feature", {}).get("id") if isinstance(ts.get("feature"), dict) else None
            category_id = ts.get("category", {}).get("id") if isinstance(ts.get("category"), dict) else None
            service_id = ts.get("service", {}).get("id") if isinstance(ts.get("service"), dict) else None
            if not service_id:
                service_id = default_service_id
            rows.append(
                {
                    "source_id": ts.get("id"),
                    "label": ts.get("label"),
                    "uom": ts.get("uom"),
                    "station_id": station_db_id,
                    "service_id": service_id,
                    "offering_id": offering_id,
                    "feature_id": feature_id,
                    "procedure_id": procedure_id,
                    "phenomenon_id": phenomenon_id,
                    "category_id": category_id,
                    "first_value_at": _parse_timestamp(ts.get("firstValueTimestamp")),
                    "last_value_at": _parse_timestamp(ts.get("lastValueTimestamp")),
                    "last_value": _safe_number(ts.get("lastValue")),
                    "extras": ts.get("extras") or ts.get("parameters"),
                    "rendering_hints": ts.get("renderingHints"),
                    "status_intervals": ts.get("statusIntervals"),
                }
            )
        if rows:
            self.client.table("timeseries").upsert(rows, on_conflict="service_id,source_id").execute()

    def get_station_id_map(self, service_id: str, source_ids: Sequence[str]) -> Dict[str, int]:
        mapping: Dict[str, int] = {}
        if not source_ids:
            return mapping
        for chunk in _chunked(list(source_ids), 500):
            resp = (
                self.client.table("stations")
                .select("id,source_id")
                .eq("service_id", service_id)
                .in_("source_id", chunk)
                .execute()
            )
            rows = resp.data if hasattr(resp, "data") else resp.get("data")
            if not rows:
                continue
            for row in rows:
                mapping[str(row["source_id"])] = int(row["id"])
        return mapping

    def get_timeseries_id_map(self, service_id: str, source_ids: Sequence[str]) -> Dict[str, int]:
        mapping: Dict[str, int] = {}
        if not source_ids:
            return mapping
        for chunk in _chunked(list(source_ids), 500):
            resp = (
                self.client.table("timeseries")
                .select("id,source_id")
                .eq("service_id", service_id)
                .in_("source_id", chunk)
                .execute()
            )
            rows = resp.data if hasattr(resp, "data") else resp.get("data")
            if not rows:
                continue
            for row in rows:
                mapping[str(row["source_id"])] = int(row["id"])
        return mapping

    def upsert_observations(
        self, series_id: int, datapoints: Iterable[Dict[str, Any]]
    ) -> None:
        rows = [
            {
                "timeseries_id": series_id,
                "observed_at": point["observed_at"],
                "value": point.get("value"),
                "status": point.get("status"),
            }
            for point in datapoints
        ]
        if rows:
            self.client.table("observations").upsert(rows, on_conflict="timeseries_id,observed_at").execute()

    def update_last_value(
        self,
        series_id: int,
        last_value_at: Optional[datetime],
        last_value: Optional[float],
    ) -> None:
        if last_value_at is None and last_value is None:
            return
        payload: Dict[str, Any] = {"id": series_id}
        if last_value_at is not None:
            payload["last_value_at"] = last_value_at.isoformat()
        if last_value is not None:
            payload["last_value"] = last_value
        self.client.table("timeseries").upsert(payload, on_conflict="id").execute()


class UkAirIngestor:
    def __init__(self, client: UkAirClient, writer: SupabaseWriter) -> None:
        self.client = client
        self.writer = writer

    def discover_service(self, preferred_id: Optional[str], preferred_label: Optional[str]) -> str:
        services = self.client.services()
        self.writer.upsert_services(services)
        if preferred_id:
            for svc in services:
                if str(svc.get("id")) == str(preferred_id):
                    return svc.get("id")
            LOG.warning("Preferred service id %s not found; falling back.", preferred_id)
        if preferred_label:
            needle = preferred_label.strip().lower()
            for svc in services:
                label = (svc.get("label") or "").lower()
                if needle and needle in label:
                    return svc.get("id")
        for svc in services:
            label = (svc.get("label") or "").lower()
            if "uk" in label and "air" in label:
                return svc.get("id")
        if not services:
            raise RuntimeError("No services returned from UK-AIR SOS.")
        return services[0].get("id")

    def discover_stations(
        self,
        service_id: str,
        bbox: Optional[Dict[str, float]],
        region: Optional[str],
        station_types: Optional[Sequence[str]],
        allow_missing_coords: bool,
    ) -> List[Dict[str, Any]]:
        raw_stations = self.client.stations(service_id, bbox=bbox, region=region)
        stations = []
        for stn in raw_stations:
            if bbox or region:
                if not _station_matches_area(stn, bbox, region, allow_missing_coords):
                    continue
            if station_types:
                stn_type = _station_type(stn)
                if not stn_type or stn_type.lower() not in station_types:
                    continue
            stations.append(stn)
        if not stations and raw_stations:
            sample = raw_stations[0]
            props = sample.get("properties") if isinstance(sample.get("properties"), dict) else {}
            LOG.warning(
                "Station filtering removed all items; sample keys=%s properties=%s",
                list(sample.keys()),
                list(props.keys()),
            )
        self.writer.upsert_stations(stations, service_id)
        return stations

    def discover_timeseries(
        self,
        service_id: str,
        station_ids: Optional[Sequence[str]],
        pollutants: Optional[Sequence[str]],
        batch_size: Optional[int],
        sample_count: int,
    ) -> List[Dict[str, Any]]:
        series = self.client.timeseries(service_id, station_ids, batch_size=batch_size)
        LOG.info("Timeseries fetched: %s", len(series))
        resolver = EionetPollutantResolver()
        for ts in series:
            _ensure_phenomenon(ts, resolver)
        if sample_count > 0 and series:
            for sample in series[:sample_count]:
                LOG.info("Timeseries sample: %s", _summarize_timeseries(sample))
        pollutant_set = {p.lower() for p in pollutants} if pollutants else set()
        if pollutant_set:
            filtered = [
                ts
                for ts in series
                if _matches_pollutant(ts, pollutant_set)
            ]
            LOG.info("Timeseries filtered: %s (pollutants=%s)", len(filtered), sorted(pollutant_set))
            if not filtered and series:
                sample = _sample_phenomena(series, limit=5)
                LOG.info("No timeseries matched pollutants; sample phenomena=%s", sample)
        else:
            filtered = series
        self.writer.upsert_reference_table("phenomena", (ts.get("phenomenon") or {} for ts in filtered))
        self.writer.upsert_reference_table("procedures", (ts.get("procedure") or {} for ts in filtered))
        self.writer.upsert_reference_table("offerings", (ts.get("offering") or {} for ts in filtered))
        station_source_ids = []
        if station_ids is not None:
            station_source_ids = [str(station_id) for station_id in station_ids]
        else:
            for ts in filtered:
                station_value = ts.get("station", {}).get("id") if isinstance(ts.get("station"), dict) else ts.get("station")
                if station_value is not None:
                    station_source_ids.append(str(station_value))
        station_id_map = self.writer.get_station_id_map(service_id, station_source_ids)
        self.writer.upsert_timeseries(filtered, service_id, station_id_map)
        timeseries_id_map = self.writer.get_timeseries_id_map(
            service_id, [str(ts.get("id")) for ts in filtered if ts.get("id")]
        )
        for ts in filtered:
            ts_source_id = ts.get("id")
            if ts_source_id is None:
                continue
            ts["_db_id"] = timeseries_id_map.get(str(ts_source_id))
        return filtered

    def backfill_year(self, series: Sequence[Dict[str, Any]], year: int, chunk_days: int = 31) -> None:
        start = datetime(year, 1, 1, tzinfo=timezone.utc)
        end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
        for ts in series:
            ts_source_id = ts.get("id")
            ts_db_id = ts.get("_db_id")
            if ts_source_id is None or ts_db_id is None:
                continue
            LOG.info("Backfilling %s for %s", ts_source_id, year)
            for chunk_start in _range_chunks(start, end, timedelta(days=chunk_days)):
                chunk_end = min(chunk_start + timedelta(days=chunk_days), end)
                timespan = f"{chunk_start.isoformat()}/{chunk_end.isoformat()}"
                data = self.client.timeseries_data(str(ts_source_id), timespan)
                points = _parse_datapoints(data.get("values", []))
                self.writer.upsert_observations(ts_db_id, points)
                last_val = data.get("lastValue") or (points[-1]["value"] if points else None)
                last_at = (
                    _parse_timestamp(data.get("lastValueTimestamp"))
                    or (points[-1]["observed_at"] if points else None)
                )
                self.writer.update_last_value(ts_db_id, last_at, _safe_number(last_val))

    def refresh_recent(self, series: Sequence[Dict[str, Any]], hours: int = 6) -> None:
        window_start = utcnow() - timedelta(hours=hours)
        window_end = utcnow()
        timespan = f"{window_start.isoformat()}/{window_end.isoformat()}"
        for ts in series:
            ts_source_id = ts.get("id")
            ts_db_id = ts.get("_db_id")
            if ts_source_id is None or ts_db_id is None:
                continue
            LOG.info("Refreshing recent window for %s (%sh)", ts_source_id, hours)
            data = self.client.timeseries_data(str(ts_source_id), timespan)
            points = _parse_datapoints(data.get("values", []))
            self.writer.upsert_observations(ts_db_id, points)
            last_val = data.get("lastValue") or (points[-1]["value"] if points else None)
            last_at = (
                _parse_timestamp(data.get("lastValueTimestamp"))
                or (points[-1]["observed_at"] if points else None)
            )
            self.writer.update_last_value(ts_db_id, last_at, _safe_number(last_val))


def _parse_datapoints(values: Iterable[Sequence[Any]]) -> List[Dict[str, Any]]:
    datapoints: List[Dict[str, Any]] = []
    for row in values:
        if len(row) < 2:
            continue
        timestamp_ms = row[0]
        value = _safe_number(row[1])
        status = row[2] if len(row) > 2 else None
        obs_time = _parse_timestamp(timestamp_ms)
        if obs_time is None:
            continue
        datapoints.append({"observed_at": obs_time.isoformat(), "value": value, "status": status})
    return datapoints


def _normalize_service_label(label: Optional[str]) -> Optional[str]:
    if label is None:
        return UK_AIR_SOS_SERVICE_LABEL
    trimmed = label.strip()
    if not trimmed:
        return UK_AIR_SOS_SERVICE_LABEL
    if trimmed.lower().startswith("my timeseries service"):
        return UK_AIR_SOS_SERVICE_LABEL
    return trimmed


def _extract_list(payload: Any, keys: Sequence[str]) -> List[Dict[str, Any]]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in keys:
            items = payload.get(key)
            if isinstance(items, list):
                return items
    return []


def _station_matches_area(
    station: Dict[str, Any],
    bbox: Optional[Dict[str, float]],
    region: Optional[str],
    allow_missing_coords: bool,
) -> bool:
    if bbox:
        if allow_missing_coords:
            if station_in_bbox_or_missing_coords(station, bbox):
                return True
        else:
            if station_in_bbox(station, bbox):
                return True
    station_region = _station_region(station)
    if region and station_region:
        return station_region.strip().lower() == region.strip().lower()
    station_label = _station_label(station)
    if region and station_label and region.strip().lower() in station_label.strip().lower():
        return True
    if not bbox and not region:
        return True
    return False


def _station_region(station: Dict[str, Any]) -> Optional[str]:
    props = station.get("properties", {}) if isinstance(station.get("properties"), dict) else {}
    return props.get("region") or station.get("region")


def _station_label(station: Dict[str, Any]) -> Optional[str]:
    props = station.get("properties", {}) if isinstance(station.get("properties"), dict) else {}
    return station.get("label") or props.get("label") or station.get("name")


def _station_type(station: Dict[str, Any]) -> Optional[str]:
    props = station.get("properties", {}) if isinstance(station.get("properties"), dict) else {}
    return props.get("stationType") or station.get("stationType")


def _parse_timestamp(raw: Any) -> Optional[datetime]:
    if raw is None:
        return None
    try:
        if isinstance(raw, (int, float)):
            return datetime.fromtimestamp(raw / 1000, tz=timezone.utc)
        if isinstance(raw, str):
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None
    return None


def _safe_number(raw: Any) -> Optional[float]:
    try:
        if raw is None:
            return None
        num = float(raw)
        if num != num:  # NaN guard
            return None
        return num
    except (ValueError, TypeError):
        return None


def _range_chunks(start: datetime, end: datetime, step: timedelta) -> Iterable[datetime]:
    cursor = start
    while cursor < end:
        yield cursor
        cursor += step


def _chunked(values: Sequence[str], size: int) -> Iterable[Sequence[str]]:
    if size <= 0:
        size = 50
    for idx in range(0, len(values), size):
        yield values[idx : idx + size]


def _parse_csv_arg(value: Optional[str]) -> Optional[List[str]]:
    if value is None:
        return None
    parts = [item.strip() for item in value.split(",")]
    cleaned = [item for item in parts if item]
    return cleaned or None


def _parse_bbox_arg(value: Optional[str]) -> Optional[Dict[str, float]]:
    if value is None:
        return UK_BBOX
    raw = value.strip()
    if not raw:
        return UK_BBOX
    lowered = raw.lower()
    if lowered in {"none", "null"}:
        return None
    if lowered in {"uk", "gb", "greatbritain"}:
        return UK_BBOX
    parts = [item.strip() for item in raw.split(",")]
    if len(parts) != 4:
        raise ValueError("bbox must be west,south,east,north")
    west, south, east, north = (float(val) for val in parts)
    return {"west": west, "south": south, "east": east, "north": north}


def _dedupe_by_id(items: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = {}
    for item in items:
        item_id = item.get("id")
        if not item_id:
            continue
        seen[item_id] = item
    return list(seen.values())


def _normalize_pollutant_text(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def _expand_pollutant_terms(pollutant_set: Set[str]) -> Set[str]:
    aliases = {
        "no2": {"no2", "nitrogendioxide"},
        "o3": {"o3", "ozone"},
        "pm10": {"pm10", "particulatematter10"},
        "pm25": {"pm25", "pm2.5", "particulatematter25"},
    }
    expanded: Set[str] = set()
    for term in pollutant_set:
        normalized = _normalize_pollutant_text(term)
        if normalized in aliases:
            expanded.update({_normalize_pollutant_text(t) for t in aliases[normalized]})
        else:
            expanded.add(normalized)
    return expanded


def _matches_pollutant(ts: Dict[str, Any], pollutant_set: Set[str]) -> bool:
    phenomenon = ts.get("phenomenon") or {}
    label = phenomenon.get("label") or ""
    phen_id = phenomenon.get("id") or ""
    fallback_label = ts.get("label") or ts.get("id") or ""
    if not label and not phen_id:
        text = _normalize_pollutant_text(str(fallback_label))
    else:
        text = _normalize_pollutant_text(f"{label} {phen_id} {fallback_label}")
    terms = _expand_pollutant_terms(pollutant_set)
    return any(term in text for term in terms)


def _sample_phenomena(series: Sequence[Dict[str, Any]], limit: int = 5) -> List[str]:
    samples: List[str] = []
    for ts in series:
        phenomenon = ts.get("phenomenon") or {}
        label = phenomenon.get("label")
        phen_id = phenomenon.get("id")
        entry = label or phen_id or ts.get("label") or ts.get("id")
        if entry:
            samples.append(str(entry))
        if len(samples) >= limit:
            break
    return samples


def _summarize_timeseries(ts: Dict[str, Any]) -> Dict[str, Any]:
    phenomenon = ts.get("phenomenon") if isinstance(ts.get("phenomenon"), dict) else None
    category = ts.get("category") if isinstance(ts.get("category"), dict) else None
    offering = ts.get("offering") if isinstance(ts.get("offering"), dict) else None
    procedure = ts.get("procedure") if isinstance(ts.get("procedure"), dict) else None
    return {
        "id": ts.get("id"),
        "label": ts.get("label"),
        "phenomenon": {
            "id": phenomenon.get("id") if phenomenon else None,
            "label": phenomenon.get("label") if phenomenon else None,
            "notation": phenomenon.get("notation") if phenomenon else None,
            "eionet_uri": phenomenon.get("eionet_uri") if phenomenon else None,
        },
        "category": {
            "id": category.get("id") if category else None,
            "label": category.get("label") if category else None,
        },
        "offering": {
            "id": offering.get("id") if offering else None,
            "label": offering.get("label") if offering else None,
        },
        "procedure": {
            "id": procedure.get("id") if procedure else None,
            "label": procedure.get("label") if procedure else None,
        },
        "uom": ts.get("uom"),
    }


class EionetPollutantResolver:
    def __init__(self, timeout: int = 20, retries: int = 2) -> None:
        self.timeout = timeout
        self.retries = retries
        self.session = requests.Session()
        self.cache: Dict[str, Optional[str]] = {}

    def resolve(self, uri: str) -> Dict[str, Optional[str]]:
        if uri in self.cache and f"{uri}#notation" in self.cache:
            return {
                "label": self.cache[uri],
                "notation": self.cache.get(f"{uri}#notation"),
            }
        label = None
        notation = None
        for attempt in range(1, self.retries + 1):
            try:
                payload = self._fetch_json(uri)
                notation = _find_json_value(payload, "notation")
                label = _extract_eionet_label(payload)
                break
            except requests.RequestException:
                if attempt == self.retries:
                    break
        self.cache[uri] = label
        self.cache[f"{uri}#notation"] = notation
        return {"label": label, "notation": notation}

    def _fetch_json(self, uri: str) -> Any:
        headers = {"Accept": "application/ld+json"}
        resp = self.session.get(uri, headers=headers, timeout=self.timeout)
        if resp.ok:
            return resp.json()
        resp = self.session.get(f"{uri}.json", timeout=self.timeout)
        if resp.ok:
            return resp.json()
        resp.raise_for_status()
        return {}


def _extract_pollutant_uri(ts: Dict[str, Any]) -> Optional[str]:
    candidates = []
    phenomenon = ts.get("phenomenon")
    if isinstance(phenomenon, dict):
        candidates.extend([phenomenon.get("id"), phenomenon.get("label")])
    candidates.extend([ts.get("label"), ts.get("id")])
    for candidate in candidates:
        if not candidate:
            continue
        match = EIONET_POLLUTANT_RE.search(str(candidate))
        if match:
            return match.group(0)
    return None


def _ensure_phenomenon(ts: Dict[str, Any], resolver: EionetPollutantResolver) -> None:
    phenomenon = ts.get("phenomenon") if isinstance(ts.get("phenomenon"), dict) else {}
    if not isinstance(phenomenon, dict):
        phenomenon = {}
    phen_id = phenomenon.get("id")
    phen_label = phenomenon.get("label")
    phen_uri = phenomenon.get("eionet_uri")
    phen_notation = phenomenon.get("notation")
    uri = None
    if not phen_id or not phen_label:
        uri = _extract_pollutant_uri(ts)
    if not phen_id and uri:
        phenomenon["id"] = uri
    if uri and not phen_uri:
        phenomenon["eionet_uri"] = uri
    if uri and (not phen_label or not phen_notation):
        resolved = resolver.resolve(uri)
        if not phen_notation and resolved.get("notation"):
            phenomenon["notation"] = resolved["notation"]
        if not phen_label and resolved.get("label"):
            phenomenon["label"] = resolved["label"]
    if not phenomenon.get("label"):
        fallback = phenomenon.get("notation") or phenomenon.get("id") or phenomenon.get("eionet_uri")
        if fallback:
            phenomenon["label"] = fallback
    if phenomenon:
        ts["phenomenon"] = phenomenon


def _extract_eionet_label(payload: Any) -> Optional[str]:
    return _find_json_value(payload, "prefLabel")


def _find_json_value(payload: Any, key: str) -> Optional[str]:
    if isinstance(payload, dict):
        if key in payload:
            return _coerce_json_value(payload.get(key))
        for value in payload.values():
            found = _find_json_value(value, key)
            if found:
                return found
    elif isinstance(payload, list):
        for item in payload:
            found = _find_json_value(item, key)
            if found:
                return found
    return None


def _coerce_json_value(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, dict):
        if "@value" in value:
            return _coerce_json_value(value.get("@value"))
        if "en" in value:
            return _coerce_json_value(value.get("en"))
    if isinstance(value, list):
        for item in value:
            coerced = _coerce_json_value(item)
            if coerced:
                return coerced
    return None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest UK-AIR SOS data into Supabase.")
    parser.add_argument("--discover", action="store_true", help="Discover services, stations, timeseries.")
    parser.add_argument("--backfill-2025", action="store_true", help="Backfill 2025 data.")
    parser.add_argument("--backfill-year", type=int, help="Backfill a specific year (overrides --backfill-2025).")
    parser.add_argument("--refresh-recent", action="store_true", help="Refresh last N hours.")
    parser.add_argument("--hours", type=int, default=6, help="Window size in hours for --refresh-recent.")
    parser.add_argument("--chunk-days", type=int, default=31, help="Chunk size for backfill requests.")
    parser.add_argument(
        "--bbox",
        default="uk",
        help="Bounding box west,south,east,north (default: uk). Use 'none' to disable.",
    )
    parser.add_argument("--no-bbox", action="store_true", help="Disable bbox filtering.")
    parser.add_argument(
        "--strict-bbox",
        action="store_true",
        help="Exclude stations with missing or invalid coordinates.",
    )
    parser.add_argument("--region", help="Region name to filter (optional).")
    parser.add_argument(
        "--station-type",
        help="Comma-separated station types to include (e.g., AURN).",
    )
    parser.add_argument(
        "--pollutants",
        default=",".join(sorted(DEFAULT_POLLUTANTS)),
        help="Comma-separated pollutant ids/labels to include (default: common pollutants). Use 'all' for no filter.",
    )
    parser.add_argument("--all-pollutants", action="store_true", help="Disable pollutant filtering.")
    parser.add_argument("--service-id", help="Explicit service id to use (optional).")
    parser.add_argument("--service-label", help="Match service label by substring (optional).")
    parser.add_argument(
        "--sample-timeseries",
        type=int,
        default=0,
        help="Log a small summary of the first N timeseries objects (default: 0).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    client = UkAirClient()
    writer = SupabaseWriter()
    ingestor = UkAirIngestor(client, writer)

    bbox = None if args.no_bbox else _parse_bbox_arg(args.bbox)
    region = args.region
    station_types = _parse_csv_arg(args.station_type)
    if station_types:
        station_types = [st_type.lower() for st_type in station_types]
    allow_missing_coords = not args.strict_bbox
    pollutants = None
    if not args.all_pollutants:
        pollutants = _parse_csv_arg(args.pollutants)
        if pollutants and len(pollutants) == 1 and pollutants[0].lower() in {"all", "*"}:
            pollutants = None

    service_id = ingestor.discover_service(args.service_id, args.service_label)
    settings = writer.get_service_settings(service_id)
    batch_size = settings.get("poll_timeseries_batch_size")
    bbox_supported = settings.get("stations_bbox_supported")
    station_filter_supported = settings.get("timeseries_station_filter_supported")
    if batch_size is not None:
        LOG.info("Using timeseries batch size from services: %s", batch_size)
    if bbox_supported is False:
        bbox = None
        LOG.info("Skipping bbox for service id %s (stations_bbox_supported=false)", service_id)
    if station_filter_supported is False:
        LOG.info(
            "Skipping station filter for service id %s (timeseries_station_filter_supported=false)",
            service_id,
        )
    LOG.info(
        "Using service id: %s (bbox=%s region=%s station_types=%s pollutants=%s)",
        service_id,
        bbox,
        region,
        station_types,
        pollutants or "all",
    )

    stations = ingestor.discover_stations(
        service_id,
        bbox,
        region,
        station_types,
        allow_missing_coords,
    )
    station_ids = [
        stn.get("id") or (stn.get("properties", {}) or {}).get("id")
        for stn in stations
        if stn.get("id") or (stn.get("properties", {}) or {}).get("id")
    ]
    if not station_ids:
        LOG.warning("No stations discovered for the given filters.")
    series = ingestor.discover_timeseries(
        service_id,
        None if station_filter_supported is False else station_ids,
        pollutants,
        batch_size,
        args.sample_timeseries,
    )

    backfill_year = args.backfill_year or (2025 if args.backfill_2025 else None)
    if backfill_year:
        ingestor.backfill_year(series, backfill_year, chunk_days=args.chunk_days)
    if args.refresh_recent:
        ingestor.refresh_recent(series, hours=args.hours)
    if not any([args.discover, backfill_year, args.refresh_recent]):
        LOG.info("No action flags set; use --discover, --backfill-year, or --refresh-recent.")


if __name__ == "__main__":
    main()
