#!/usr/bin/env python3
"""
Sensor.Community ingestion helper (UK only).

This script:
1) Fetches recent sensor values from data.sensor.community for GB.
2) Upserts connector + station metadata into Supabase.
3) Creates/updates timeseries per station + pollutant.
4) Inserts observations for the latest values.

Environment:
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- SCOMM_BASE_URL (optional; defaults to https://data.sensor.community)
- SCOMM_CONNECTOR_REF (optional; defaults to sensorcommunity)
- SCOMM_CONNECTOR_LABEL (optional; defaults to Sensor.Community)
- SCOMM_COUNTRY (optional; defaults to GB)
- SCOMM_USER_AGENT (optional; identifies your client per Sensor.Community guidance)

Example:
  python scripts/sensorcommunity_ingest.py --refresh-recent
"""

import argparse
import json
import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests
from dotenv import load_dotenv
from supabase import Client, create_client

from ingest_helpers import station_coords, station_in_bbox_or_missing_coords

load_dotenv()

LOG = logging.getLogger("sensorcommunity_ingest")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

SCOMM_BASE_URL = (os.getenv("SCOMM_BASE_URL") or "https://data.sensor.community").rstrip("/")
SCOMM_CONNECTOR_REF = os.getenv("SCOMM_CONNECTOR_REF", "sensorcommunity")
SCOMM_CONNECTOR_LABEL = os.getenv("SCOMM_CONNECTOR_LABEL", "Sensor.Community")
SCOMM_COUNTRY = os.getenv("SCOMM_COUNTRY", "GB")
SCOMM_USER_AGENT = os.getenv("SCOMM_USER_AGENT", "uk-air-quality-networks")

UK_BBOX = {
    "west": -11.0,
    "south": 49.0,
    "east": 2.0,
    "north": 61.0,
}

VALUE_TYPE_MAP = {
    "P1": {"pollutant": "pm10", "label": "PM10", "uom": "ug/m3"},
    "P2": {"pollutant": "pm2.5", "label": "PM2.5", "uom": "ug/m3"},
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def parse_timestamp(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    cleaned = value.strip()
    if cleaned.endswith("Z"):
        cleaned = cleaned[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(cleaned)
    except ValueError:
        try:
            return datetime.strptime(cleaned, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        except ValueError:
            return None


def coerce_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


class SensorCommunityClient:
    def __init__(self, base_url: str = SCOMM_BASE_URL, timeout: int = 60, retries: int = 3):
        self.base_url = base_url
        self.timeout = timeout
        self.retries = retries
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": SCOMM_USER_AGENT})

    def get(self, path: str) -> Any:
        url = f"{self.base_url}/{path.lstrip('/')}"
        for attempt in range(1, self.retries + 1):
            try:
                resp = self.session.get(url, timeout=self.timeout)
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
        time.sleep(min(30, 2**attempt))

    def recent_values(self) -> List[Dict[str, Any]]:
        payload = self.get(f"/airrohr/v1/filter/country={SCOMM_COUNTRY}")
        if isinstance(payload, list):
            LOG.info("Fetched %s recent sensor payloads.", len(payload))
            return payload
        return []


@dataclass(frozen=True)
class TimeseriesKey:
    station_ref: str
    pollutant: str


class SupabaseWriter:
    def __init__(self) -> None:
        supabase_url = os.getenv("SUPABASE_URL")
        supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if not supabase_url or not supabase_key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")
        self.client: Client = create_client(supabase_url, supabase_key)

    def upsert_connector(self) -> int:
        payload = {
            "connector_ref": SCOMM_CONNECTOR_REF,
            "label": SCOMM_CONNECTOR_LABEL,
            "connector_url": SCOMM_BASE_URL,
            "poll_enabled": True,
            "poll_interval_minutes": 15,
            "poll_window_hours": 1,
        }
        self.client.table("connectors").upsert(payload, on_conflict="connector_ref").execute()
        row = (
            self.client.table("connectors")
            .select("id")
            .eq("connector_ref", SCOMM_CONNECTOR_REF)
            .single()
            .execute()
        )
        data = row.data if hasattr(row, "data") else row.get("data")
        if not data:
            raise RuntimeError("Failed to resolve connector id for Sensor.Community.")
        return int(data["id"])

    def upsert_stations(self, stations: Iterable[Dict[str, Any]], connector_id: int) -> int:
        rows = []
        for station in stations:
            payload = normalize_station_payload(station)
            station_ref = payload.get("station_ref")
            if not station_ref:
                continue
            lon = payload.get("longitude")
            lat = payload.get("latitude")
            rows.append(
                {
                    "station_ref": station_ref,
                    "label": payload.get("label") or f"Sensor.Community {station_ref}",
                    "station_name": payload.get("station_name"),
                    "station_type": payload.get("station_type"),
                    "geometry": (
                        f"SRID=4326;POINT({lon} {lat})"
                        if lon is not None and lat is not None
                        else None
                    ),
                    "connector_id": connector_id,
                    "last_seen_at": utcnow().isoformat(),
                    "removed_at": None,
                }
            )
        if rows:
            self.client.table("stations").upsert(
                rows, on_conflict="connector_id,station_ref"
            ).execute()
        return len(rows)

    def fetch_station_ids(self, connector_id: int, station_refs: Iterable[str]) -> Dict[str, int]:
        refs = [str(ref) for ref in station_refs if ref]
        if not refs:
            return {}
        mapping: Dict[str, int] = {}
        for chunk in chunked(refs, 200):
            resp = (
                self.client.table("stations")
                .select("id,station_ref")
                .eq("connector_id", connector_id)
                .in_("station_ref", list(chunk))
                .execute()
            )
            rows = resp.data if hasattr(resp, "data") else resp.get("data")
            for row in rows or []:
                mapping[str(row["station_ref"])] = int(row["id"])
        return mapping

    def upsert_timeseries(
        self,
        timeseries_rows: Iterable[Dict[str, Any]],
    ) -> None:
        rows = list(timeseries_rows)
        if rows:
            self.client.table("timeseries").upsert(
                rows, on_conflict="connector_id,timeseries_ref"
            ).execute()

    def fetch_timeseries_ids(
        self, connector_id: int, timeseries_refs: Iterable[str]
    ) -> Dict[str, int]:
        refs = [str(ref) for ref in timeseries_refs if ref]
        if not refs:
            return {}
        mapping: Dict[str, int] = {}
        for chunk in chunked(refs, 200):
            resp = (
                self.client.table("timeseries")
                .select("id,timeseries_ref")
                .eq("connector_id", connector_id)
                .in_("timeseries_ref", list(chunk))
                .execute()
            )
            rows = resp.data if hasattr(resp, "data") else resp.get("data")
            for row in rows or []:
                mapping[str(row["timeseries_ref"])] = int(row["id"])
        return mapping

    def upsert_observations(self, rows: Iterable[Dict[str, Any]]) -> int:
        payload = list(rows)
        if not payload:
            return 0
        self.client.table("observations").upsert(
            payload, on_conflict="timeseries_id,observed_at"
        ).execute()
        return len(payload)


def chunked(values: List[str], size: int) -> Iterable[List[str]]:
    if size <= 0:
        size = 200
    for idx in range(0, len(values), size):
        yield values[idx : idx + size]


def normalize_station_payload(station: Dict[str, Any]) -> Dict[str, Any]:
    location = station.get("location") if isinstance(station.get("location"), dict) else {}
    sensor = station.get("sensor") if isinstance(station.get("sensor"), dict) else {}
    sensor_type = station.get("sensor_type") if isinstance(station.get("sensor_type"), dict) else {}
    lat = location.get("latitude")
    lon = location.get("longitude")
    station_stub = {
        "properties": {
            "latitude": lat,
            "longitude": lon,
        }
    }
    lon_val, lat_val = station_coords(station_stub, bbox=UK_BBOX)
    station_ref = sensor.get("id") or station.get("sensor_id") or station.get("id")
    label = location.get("name") or station.get("location_name")
    station_type = sensor_type.get("name") or sensor_type.get("id")
    return {
        "station_ref": str(station_ref) if station_ref is not None else None,
        "label": label,
        "station_name": label,
        "station_type": station_type,
        "longitude": lon_val,
        "latitude": lat_val,
    }


def station_stub(station: Dict[str, Any]) -> Dict[str, Any]:
    location = station.get("location") if isinstance(station.get("location"), dict) else {}
    return {
        "properties": {
            "longitude": location.get("longitude"),
            "latitude": location.get("latitude"),
        }
    }


def build_observation_rows(
    station_ref: str,
    record: Dict[str, Any],
    observed_at: datetime,
) -> Tuple[List[Tuple[TimeseriesKey, Optional[float]]], List[str]]:
    values = []
    timeseries_refs = []
    sensor_values = record.get("sensordatavalues")
    if not isinstance(sensor_values, list):
        return [], []
    for entry in sensor_values:
        if not isinstance(entry, dict):
            continue
        value_type = entry.get("value_type")
        mapped = VALUE_TYPE_MAP.get(str(value_type))
        if not mapped:
            continue
        value = coerce_float(entry.get("value"))
        pollutant = mapped["pollutant"]
        key = TimeseriesKey(station_ref=station_ref, pollutant=pollutant)
        timeseries_ref = f"{station_ref}:{pollutant}"
        values.append((key, value))
        timeseries_refs.append(timeseries_ref)
    return values, timeseries_refs


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest Sensor.Community measurements for the UK.")
    parser.add_argument(
        "--refresh-recent",
        action="store_true",
        help="Fetch recent values and upsert observations.",
    )
    parser.add_argument(
        "--raw-output",
        help="Write raw payloads to this file (JSON).",
    )
    parser.add_argument(
        "--no-filter",
        action="store_true",
        help="Skip the UK bounding box filter and ingest all stations in the response.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.refresh_recent:
        LOG.error("No action specified. Use --refresh-recent.")
        raise SystemExit(2)
    client = SensorCommunityClient()
    payload = client.recent_values()
    if not payload:
        LOG.warning("No sensor values returned from Sensor.Community.")
        return

    filtered = (
        payload
        if args.no_filter
        else [s for s in payload if station_in_bbox_or_missing_coords(station_stub(s), UK_BBOX)]
    )

    if args.raw_output:
        with open(args.raw_output, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "source": SCOMM_BASE_URL,
                    "fetched_at": utcnow().isoformat(),
                    "bbox": None if args.no_filter else UK_BBOX,
                    "count": len(filtered),
                    "stations": filtered,
                },
                handle,
                indent=2,
            )

    writer = SupabaseWriter()
    connector_id = writer.upsert_connector()
    writer.upsert_stations(filtered, connector_id)

    station_refs = []
    observations_by_timeseries: Dict[TimeseriesKey, Tuple[Optional[float], datetime]] = {}
    timeseries_refs: List[str] = []
    for record in filtered:
        payload = normalize_station_payload(record)
        station_ref = payload.get("station_ref")
        if not station_ref:
            continue
        station_refs.append(station_ref)
        observed_at = parse_timestamp(record.get("timestamp")) or utcnow()
        values, series_refs = build_observation_rows(station_ref, record, observed_at)
        timeseries_refs.extend(series_refs)
        for key, value in values:
            existing = observations_by_timeseries.get(key)
            if existing is None or existing[1] < observed_at:
                observations_by_timeseries[key] = (value, observed_at)

    station_id_map = writer.fetch_station_ids(connector_id, station_refs)
    timeseries_payload = []
    for key, (value, observed_at) in observations_by_timeseries.items():
        station_id = station_id_map.get(key.station_ref)
        if not station_id:
            continue
        mapped = VALUE_TYPE_MAP.get(
            "P1" if key.pollutant == "pm10" else "P2"
        )
        label = f"{key.station_ref} {mapped['label']}" if mapped else key.pollutant
        timeseries_payload.append(
            {
                "timeseries_ref": f"{key.station_ref}:{key.pollutant}",
                "label": label,
                "uom": mapped["uom"] if mapped else None,
                "station_id": station_id,
                "connector_id": connector_id,
                "last_value_at": observed_at.isoformat(),
                "last_value": value,
            }
        )

    writer.upsert_timeseries(timeseries_payload)
    timeseries_id_map = writer.fetch_timeseries_ids(connector_id, timeseries_refs)

    observation_rows = []
    for key, (value, observed_at) in observations_by_timeseries.items():
        timeseries_ref = f"{key.station_ref}:{key.pollutant}"
        timeseries_id = timeseries_id_map.get(timeseries_ref)
        if not timeseries_id:
            continue
        observation_rows.append(
            {
                "timeseries_id": timeseries_id,
                "observed_at": observed_at.isoformat(),
                "value": value,
                "status": None,
            }
        )

    inserted = writer.upsert_observations(observation_rows)
    LOG.info("Upserted %s observations.", inserted)


if __name__ == "__main__":
    main()
