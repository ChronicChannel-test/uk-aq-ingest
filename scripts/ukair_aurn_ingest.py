#!/usr/bin/env python3
"""
UK-AIR / AURN ingestion helper.

This script:
1) Discovers SOS metadata (services, stations, timeseries) for Bristol AURN sites.
2) Backfills 2025 observations for those timeseries.
3) Supports incremental refreshes for the last N hours (default 6h).

Environment:
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- UKAIR_BASE_URL (optional; defaults to https://uk-air.defra.gov.uk/sos-ukair/api/v1)

Examples:
  python scripts/ukair_aurn_ingest.py --discover --backfill-2025
  python scripts/ukair_aurn_ingest.py --refresh-recent --hours 6
"""

import argparse
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence

import requests
from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv()

LOG = logging.getLogger("ukair_aurn")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

UKAIR_BASE_URL = os.getenv(
    "UKAIR_BASE_URL", "https://uk-air.defra.gov.uk/sos-ukair/api/v1"
).rstrip("/")

BRISTOL_BBOX = {
    "west": -2.75,
    "south": 51.30,
    "east": -2.45,
    "north": 51.55,
}
BRISTOL_REGION = "Bristol"
AURN_STATION_TYPE = "AURN"
POLLUTANTS = {"no2", "o3", "pm10", "pm2.5"}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UkAirClient:
    def __init__(self, base_url: str = UKAIR_BASE_URL, timeout: int = 60, retries: int = 3):
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
            except requests.RequestException as exc:
                LOG.warning("Request failed (attempt %s/%s): %s", attempt, self.retries, exc)
                if attempt == self.retries:
                    raise
                self._sleep(attempt)
        return {}

    def _sleep(self, attempt: int) -> None:
        delay = min(30, 2**attempt)
        time.sleep(delay)

    def services(self) -> List[Dict[str, Any]]:
        data = self.get("/services")
        return data.get("services", data.get("data", []))

    def stations(
        self, service_id: str, bbox: Dict[str, float], region: str = BRISTOL_REGION
    ) -> List[Dict[str, Any]]:
        params = {
            "service": service_id,
            "bbox": f"{bbox['west']},{bbox['south']},{bbox['east']},{bbox['north']}",
        }
        if region:
            params["region"] = region
        data = self.get("/stations", params=params)
        return data.get("stations", data.get("data", []))

    def timeseries(self, service_id: str, station_ids: Sequence[str]) -> List[Dict[str, Any]]:
        params: Dict[str, Any] = {"service": service_id, "expanded": "true"}
        for station_id in station_ids:
            params.setdefault("station", []).append(station_id)
        data = self.get("/timeseries", params=params)
        return data.get("timeseries", data.get("data", []))

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

    def upsert_reference_table(self, table: str, items: Iterable[Dict[str, Any]]) -> None:
        payload = [
            {"id": item.get("id"), "label": item.get("label"), "service_id": item.get("service", {}).get("id")}
            for item in items
            if item.get("id") and item.get("label")
        ]
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
            rows.append(
                {
                    "id": station.get("id"),
                    "label": station.get("label") or props.get("label"),
                    "station_type": props.get("stationType") or station.get("stationType"),
                    "region": props.get("region") or station.get("region"),
                    "geometry": f"SRID=4326;POINT({lon} {lat})" if lon is not None and lat is not None else None,
                    "service_id": service_id,
                    "category_id": props.get("category", {}).get("id") if isinstance(props.get("category"), dict) else None,
                    "phenomenon_id": props.get("phenomenon", {}).get("id")
                    if isinstance(props.get("phenomenon"), dict)
                    else None,
                }
            )
        if rows:
            self.client.table("stations").upsert(rows, on_conflict="id").execute()

    def upsert_timeseries(self, series: Iterable[Dict[str, Any]]) -> None:
        rows = []
        for ts in series:
            station_id = ts.get("station", {}).get("id") if isinstance(ts.get("station"), dict) else ts.get("station")
            phenomenon_id = ts.get("phenomenon", {}).get("id") if isinstance(ts.get("phenomenon"), dict) else None
            procedure_id = ts.get("procedure", {}).get("id") if isinstance(ts.get("procedure"), dict) else None
            offering_id = ts.get("offering", {}).get("id") if isinstance(ts.get("offering"), dict) else None
            feature_id = ts.get("feature", {}).get("id") if isinstance(ts.get("feature"), dict) else None
            category_id = ts.get("category", {}).get("id") if isinstance(ts.get("category"), dict) else None
            service_id = ts.get("service", {}).get("id") if isinstance(ts.get("service"), dict) else None
            rows.append(
                {
                    "id": ts.get("id"),
                    "label": ts.get("label"),
                    "uom": ts.get("uom"),
                    "station_id": station_id,
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
            self.client.table("timeseries").upsert(rows, on_conflict="id").execute()

    def upsert_observations(
        self, series_id: str, datapoints: Iterable[Dict[str, Any]]
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
        series_id: str,
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

    def discover_service(self) -> str:
        services = self.client.services()
        self.writer.upsert_services(services)
        for svc in services:
            label = (svc.get("label") or "").lower()
            if "uk" in label and "air" in label:
                return svc.get("id")
        if not services:
            raise RuntimeError("No services returned from UK-AIR SOS.")
        return services[0].get("id")

    def discover_bristol_stations(self, service_id: str) -> List[Dict[str, Any]]:
        stations = self.client.stations(service_id, BRISTOL_BBOX, region=BRISTOL_REGION)
        stations = [
            stn
            for stn in stations
            if (stn.get("properties", {}) or {}).get("stationType") == AURN_STATION_TYPE
            or stn.get("stationType") == AURN_STATION_TYPE
        ]
        self.writer.upsert_stations(stations, service_id)
        return stations

    def discover_timeseries(self, service_id: str, station_ids: Sequence[str]) -> List[Dict[str, Any]]:
        series = self.client.timeseries(service_id, station_ids)
        filtered = [
            ts
            for ts in series
            if (ts.get("phenomenon", {}).get("label") or "").lower() in POLLUTANTS
            or (ts.get("phenomenon", {}).get("id") or "").lower() in POLLUTANTS
        ]
        self.writer.upsert_reference_table("phenomena", (ts.get("phenomenon") or {} for ts in filtered))
        self.writer.upsert_reference_table("procedures", (ts.get("procedure") or {} for ts in filtered))
        self.writer.upsert_reference_table("offerings", (ts.get("offering") or {} for ts in filtered))
        self.writer.upsert_timeseries(filtered)
        return filtered

    def backfill_year(self, series: Sequence[Dict[str, Any]], year: int, chunk_days: int = 31) -> None:
        start = datetime(year, 1, 1, tzinfo=timezone.utc)
        end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
        for ts in series:
            ts_id = ts["id"]
            LOG.info("Backfilling %s for %s", ts_id, year)
            for chunk_start in _range_chunks(start, end, timedelta(days=chunk_days)):
                chunk_end = min(chunk_start + timedelta(days=chunk_days), end)
                timespan = f"{chunk_start.isoformat()}/{chunk_end.isoformat()}"
                data = self.client.timeseries_data(ts_id, timespan)
                points = _parse_datapoints(data.get("values", []))
                self.writer.upsert_observations(ts_id, points)
                last_val = data.get("lastValue") or (points[-1]["value"] if points else None)
                last_at = (
                    _parse_timestamp(data.get("lastValueTimestamp"))
                    or (points[-1]["observed_at"] if points else None)
                )
                self.writer.update_last_value(ts_id, last_at, _safe_number(last_val))

    def refresh_recent(self, series: Sequence[Dict[str, Any]], hours: int = 6) -> None:
        window_start = utcnow() - timedelta(hours=hours)
        window_end = utcnow()
        timespan = f"{window_start.isoformat()}/{window_end.isoformat()}"
        for ts in series:
            ts_id = ts["id"]
            LOG.info("Refreshing recent window for %s (%sh)", ts_id, hours)
            data = self.client.timeseries_data(ts_id, timespan)
            points = _parse_datapoints(data.get("values", []))
            self.writer.upsert_observations(ts_id, points)
            last_val = data.get("lastValue") or (points[-1]["value"] if points else None)
            last_at = (
                _parse_timestamp(data.get("lastValueTimestamp"))
                or (points[-1]["observed_at"] if points else None)
            )
            self.writer.update_last_value(ts_id, last_at, _safe_number(last_val))


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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest UK-AIR AURN data into Supabase.")
    parser.add_argument("--discover", action="store_true", help="Discover services, stations, timeseries.")
    parser.add_argument("--backfill-2025", action="store_true", help="Backfill 2025 data for Bristol AURN series.")
    parser.add_argument("--refresh-recent", action="store_true", help="Refresh last N hours for Bristol AURN series.")
    parser.add_argument("--hours", type=int, default=6, help="Window size in hours for --refresh-recent.")
    parser.add_argument("--chunk-days", type=int, default=31, help="Chunk size for backfill requests.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    client = UkAirClient()
    writer = SupabaseWriter()
    ingestor = UkAirIngestor(client, writer)

    service_id = ingestor.discover_service()
    LOG.info("Using service id: %s", service_id)

    stations = ingestor.discover_bristol_stations(service_id)
    station_ids = [stn["id"] for stn in stations if stn.get("id")]
    if not station_ids:
        LOG.warning("No Bristol AURN stations discovered.")
    series = ingestor.discover_timeseries(service_id, station_ids) if station_ids else []

    if args.backfill_2025:
        ingestor.backfill_year(series, 2025, chunk_days=args.chunk_days)
    if args.refresh_recent:
        ingestor.refresh_recent(series, hours=args.hours)
    if not any([args.discover, args.backfill_2025, args.refresh_recent]):
        LOG.info("No action flags set; use --discover, --backfill-2025, or --refresh-recent.")


if __name__ == "__main__":
    main()
