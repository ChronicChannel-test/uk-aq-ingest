#!/usr/bin/env python3
"""Ingest Breathe London Nodes /SensorData observations.

Examples:
  python3 scripts/blondon_nodes/blondon_nodes_ingest.py --dry-run --max-stations 1 --max-api-calls 4
  python3 scripts/blondon_nodes/blondon_nodes_ingest.py --site-code BL0001 --species PM25 --start-time 2026-06-27T10:00:00Z --end-time 2026-06-28T10:00:00Z --dry-run
"""

import argparse
import base64
import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import requests
from dotenv import load_dotenv
from supabase import Client, create_client

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if PROJECT_ROOT.name == "scripts":
    PROJECT_ROOT = PROJECT_ROOT.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scripts.uk_aq_supabase import SupabaseSchemas, create_supabase_client

load_dotenv()

LOG = logging.getLogger("blondon_nodes_ingest")
DEFAULT_LOG_LEVEL = os.getenv("BLONDON_NODES_LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=getattr(logging, DEFAULT_LOG_LEVEL, logging.INFO), format="%(asctime)s %(levelname)s %(message)s")
logging.getLogger("httpx").setLevel(getattr(logging, DEFAULT_LOG_LEVEL, logging.INFO))
logging.getLogger("postgrest").setLevel(getattr(logging, DEFAULT_LOG_LEVEL, logging.INFO))

CONNECTOR_CODE = "blondon_nodes"
SERVICE_REF = os.getenv("BLONDON_NODES_SERVICE_REF", "breathelondon")
BASE_URL = os.getenv("BLONDON_NODES_BASE_URL", "https://breathe-london-7x54d7qf.ew.gateway.dev").rstrip("/")
DEFAULT_SPECIES = ("PM25", "NO2", "PM25Index", "NO2Index")
DEFAULT_BATCH_SIZE = 500
DEFAULT_OVERLAP_MINUTES = 10
DEFAULT_SLEEP_SECONDS = 0.1

SPECIES_CONFIG: Dict[str, Dict[str, str]] = {
    "PM25": {"label": "PM2.5", "uom": "ug.m-3", "source_label": "breathelondon_nodes:pm2.5", "notation": "PM2.5", "pollutant_label": "pm2.5", "kind": "pollutant"},
    "NO2": {"label": "NO2", "uom": "ug.m-3", "source_label": "breathelondon_nodes:no2", "notation": "NO2", "pollutant_label": "no2", "kind": "pollutant"},
    "PM25Index": {"label": "PM2.5 DAQI", "uom": "DAQI", "source_label": "breathelondon_nodes:pm2.5:daqi", "notation": "PM2.5 DAQI", "pollutant_label": "pm2.5", "kind": "daqi_index"},
    "NO2Index": {"label": "NO2 DAQI", "uom": "DAQI", "source_label": "breathelondon_nodes:no2:daqi", "notation": "NO2 DAQI", "pollutant_label": "no2", "kind": "daqi_index"},
}


def chunked(values: Sequence[Any], size: int) -> List[Sequence[Any]]:
    return [values[index:index + size] for index in range(0, len(values), size)]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def floor_to_minute(value: datetime) -> datetime:
    return value.astimezone(timezone.utc).replace(second=0, microsecond=0)


def coerce_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_species(value: Optional[str]) -> List[str]:
    if not value:
        return list(DEFAULT_SPECIES)
    wanted = []
    allowed = {item.upper(): item for item in DEFAULT_SPECIES}
    for raw in value.split(","):
        key = raw.strip().upper()
        if key in allowed:
            wanted.append(allowed[key])
    return wanted


class BreatheLondonNodesClient:
    def __init__(self, api_key: str, base_url: str = BASE_URL, timeout: int = 60, retries: int = 3) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.retries = retries
        self.session = requests.Session()
        self.session.headers.update({"X-API-KEY": api_key, "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "uk-air-quality-networks"})

    def sensor_data(self, site_code: str, species: str, start_time: datetime, end_time: datetime) -> List[Dict[str, Any]]:
        params = {"SiteCode": site_code, "Species": species, "startTime": iso_z(start_time), "endTime": iso_z(end_time)}
        url = f"{self.base_url}/SensorData"
        for attempt in range(1, self.retries + 1):
            try:
                resp = self.session.get(url, params=params, timeout=self.timeout)
                if resp.status_code in (429, 500, 502, 503, 504):
                    time.sleep(min(30, 2 ** attempt)); continue
                resp.raise_for_status()
                payload = resp.json()
                if payload is None:
                    return []
                if not isinstance(payload, list):
                    raise RuntimeError(f"Unexpected /SensorData payload type: {type(payload).__name__}")
                return [row for row in payload if isinstance(row, dict)]
            except requests.RequestException as exc:
                LOG.warning("Nodes request failed (attempt %s/%s): %s", attempt, self.retries, exc)
                if attempt == self.retries:
                    raise
                time.sleep(min(30, 2 ** attempt))
        return []


class PubSubPublisher:
    def __init__(self) -> None:
        self.project_id = (os.getenv("GCP_PROJECT_ID") or os.getenv("GOOGLE_CLOUD_PROJECT") or "").strip()
        self.observs_topic = (os.getenv("GCP_OBSERVS_PUBSUB_TOPIC") or "uk-aq-observs-observations").strip()
        self.latest_topic = (os.getenv("GCP_LATEST_SNAPSHOT_PUBSUB_TOPIC") or "uk-aq-latest-snapshot-requests").strip()
        self.batch_size = int(os.getenv("OBSERVS_PUBSUB_PUBLISH_BATCH_SIZE") or "500")

    def _topic_path(self, topic: str) -> str:
        if topic.startswith("projects/"):
            return topic
        if not self.project_id:
            return ""
        return f"projects/{self.project_id}/topics/{topic}"

    def _token(self) -> str:
        resp = requests.get("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", headers={"Metadata-Flavor": "Google"}, timeout=10)
        resp.raise_for_status()
        token = resp.json().get("access_token")
        if not token:
            raise RuntimeError("Metadata token response missing access_token")
        return str(token)

    def publish(self, topic: str, rows: Sequence[Dict[str, Any]], attr_keys: Sequence[str]) -> int:
        path = self._topic_path(topic)
        if not rows or not path:
            return 0
        token = self._token()
        count = 0
        for rows_chunk in [rows[i:i+self.batch_size] for i in range(0, len(rows), self.batch_size)]:
            messages = []
            for row in rows_chunk:
                attrs = {key: str(row[key]) for key in attr_keys if row.get(key) is not None}
                messages.append({"data": base64.b64encode(json.dumps(row, separators=(",", ":")).encode()).decode(), "attributes": attrs})
            resp = requests.post(f"https://pubsub.googleapis.com/v1/{path}:publish", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, json={"messages": messages}, timeout=30)
            if not resp.ok:
                raise RuntimeError(f"Pub/Sub publish failed for {path}: HTTP {resp.status_code} {resp.text[:500]}")
            payload = resp.json()
            count += len(payload.get("messageIds") or messages)
        return count

    def publish_observations(self, rows: Sequence[Dict[str, Any]]) -> int:
        return self.publish(self.observs_topic, rows, ("connector_id", "timeseries_id", "observed_at"))

    def publish_latest(self, rows: Sequence[Dict[str, Any]]) -> int:
        latest = []
        seen: set[int] = set()
        for row in sorted(rows, key=lambda item: str(item.get("observed_at") or ""), reverse=True):
            ts_id = int(row["timeseries_id"])
            if ts_id in seen:
                continue
            seen.add(ts_id)
            latest.append({"connector_id": row["connector_id"], "timeseries_id": ts_id, "observed_at": row["observed_at"]})
        return self.publish(self.latest_topic, latest, ("connector_id", "timeseries_id"))


class ObservsWriter:
    def __init__(self, main_client: Client) -> None:
        requested_mode = (os.getenv("OBSERVS_WRITE_MODE") or "").strip().lower()
        self.mode = requested_mode if requested_mode in {"direct", "outbox_only", "pubsub_only"} else "outbox_only"
        self.main_public = main_client.schema(os.getenv("UK_AQ_PUBLIC_SCHEMA") or "uk_aq_public")
        self.publisher = PubSubPublisher() if self.mode == "pubsub_only" else None
        self.direct = None
        if self.mode == "direct":
            url = (os.getenv("OBS_AQIDB_SUPABASE_URL") or "").strip()
            key = (os.getenv("OBS_AQIDB_SECRET_KEY") or "").strip()
            if not url or not key:
                raise RuntimeError(
                    "OBSERVS_WRITE_MODE=direct requires OBS_AQIDB_SUPABASE_URL and OBS_AQIDB_SECRET_KEY"
                )
            self.direct = create_client(url, key).schema(
                os.getenv("OBS_AQIDB_RPC_SCHEMA") or "uk_aq_public"
            )

    @staticmethod
    def _rows(rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [
            {
                "connector_id": row["connector_id"],
                "timeseries_id": row["timeseries_id"],
                "observed_at": row["observed_at"],
                "value": row["value"],
                "status": row["status"],
            }
            for row in rows
        ]

    def write(self, rows: Sequence[Dict[str, Any]]) -> Tuple[int, int]:
        payload = self._rows(rows)
        if not payload:
            return 0, 0
        if self.mode == "pubsub_only":
            assert self.publisher is not None
            return (
                self.publisher.publish_observations(payload),
                self.publisher.publish_latest(payload),
            )
        if self.mode == "direct":
            assert self.direct is not None
            self.direct.rpc("uk_aq_rpc_observs_observations_upsert", {"rows": payload}).execute()
            return len(payload), 0
        self.main_public.rpc(
            "uk_aq_rpc_observs_outbox_enqueue",
            {"entries": [{"payload": payload}]},
        ).execute()
        return 0, 0


class SupabaseWriter:
    def __init__(self) -> None:
        self.client: Client = create_supabase_client()
        schemas = SupabaseSchemas.from_client(self.client)
        self.core = schemas.core
        self.raw = schemas.raw

    def fetch_connector(self) -> Dict[str, Any]:
        resp = self.core.table("connectors").select("id,poll_enabled,poll_window_hours,poll_interval_minutes,poll_timeseries_batch_size").eq("connector_code", CONNECTOR_CODE).limit(1).execute()
        rows = resp.data if hasattr(resp, "data") else resp.get("data")
        if not rows:
            raise RuntimeError("Connector not found for blondon_nodes. Run the station import first.")
        return dict(rows[0])

    def fetch_active_stations(self, connector_id: int, site_code: Optional[str], limit: Optional[int]) -> List[Dict[str, Any]]:
        query = self.core.table("stations").select("id,station_ref,station_name,label").eq("connector_id", connector_id).eq("service_ref", SERVICE_REF).filter("removed_at", "is", "null").order("station_ref")
        if site_code:
            query = query.eq("station_ref", site_code)
        if limit:
            query = query.limit(limit)
        resp = query.execute()
        return resp.data if hasattr(resp, "data") else resp.get("data") or []

    def upsert_phenomena(self, connector_id: int, species: Sequence[str]) -> Dict[str, int]:
        rows = [{"connector_id": connector_id, "label": SPECIES_CONFIG[s]["label"], "source_label": SPECIES_CONFIG[s]["source_label"], "notation": SPECIES_CONFIG[s]["notation"], "pollutant_label": SPECIES_CONFIG[s]["pollutant_label"]} for s in species]
        self.core.table("phenomena").upsert(rows, on_conflict="connector_id,source_label").execute()
        resp = self.core.table("phenomena").select("id,source_label").eq("connector_id", connector_id).in_("source_label", [r["source_label"] for r in rows]).execute()
        return {str(r["source_label"]): int(r["id"]) for r in (resp.data or [])}

    def upsert_timeseries(self, rows: Sequence[Dict[str, Any]]) -> Dict[str, int]:
        if rows:
            self.core.table("timeseries").upsert(list(rows), on_conflict="connector_id,timeseries_ref").execute()
        refs = [r["timeseries_ref"] for r in rows]
        out: Dict[str, int] = {}
        for refs_chunk in chunked(refs, 200):
            resp = self.core.table("timeseries").select("id,timeseries_ref").eq("connector_id", rows[0]["connector_id"]).in_("timeseries_ref", refs_chunk).execute()
            for r in resp.data or []:
                out[str(r["timeseries_ref"])] = int(r["id"])
        return out

    def fetch_checkpoints(self, station_ids: Sequence[int], species: Sequence[str]) -> Dict[Tuple[int, str], Dict[str, Any]]:
        out: Dict[Tuple[int, str], Dict[str, Any]] = {}
        for ids in chunked([str(v) for v in station_ids], 200):
            resp = self.raw.table("blondon_nodes_timeseries_checkpoints").select("station_id,species,timeseries_id,last_observed_at,last_polled_at,last_error").in_("station_id", ids).in_("species", list(species)).execute()
            for r in resp.data or []:
                out[(int(r["station_id"]), str(r["species"]))] = r
        return out

    def upsert_observations(self, rows: Sequence[Dict[str, Any]]) -> int:
        if rows:
            self.core.table("observations").upsert(
                [
                    {
                        "timeseries_id": r["timeseries_id"],
                        "observed_at": r["observed_at"],
                        "value": r["value"],
                        "status": r["status"],
                    }
                    for r in rows
                ],
                on_conflict="timeseries_id,observed_at",
            ).execute()
        return len(rows)

    def update_timeseries_last_values(self, rows: Sequence[Dict[str, Any]]) -> None:
        for row in rows:
            self.core.table("timeseries").update({"last_value": row["value"], "last_value_at": row["observed_at"]}).eq("id", row["timeseries_id"]).execute()

    def upsert_checkpoints(self, rows: Sequence[Dict[str, Any]]) -> None:
        if rows:
            self.raw.table("blondon_nodes_timeseries_checkpoints").upsert(list(rows), on_conflict="station_id,species").execute()

    def update_connector_last_polled(self, connector_id: int) -> None:
        self.core.table("connectors").update({"last_polled_at": utcnow().isoformat()}).eq("id", connector_id).execute()


def build_rows(payload: Sequence[Dict[str, Any]], timeseries_id: int, connector_id: int, station_id: int, species: str) -> Tuple[List[Dict[str, Any]], int, Optional[str], Optional[float]]:
    rows = []
    nulls = 0
    last_at: Optional[datetime] = None
    last_value: Optional[float] = None
    for entry in payload:
        value = coerce_float(entry.get("ScaledValue"))
        if value is None:
            nulls += 1; continue
        observed = parse_iso(entry.get("DateTime"))
        if observed is None:
            continue
        meta = {k: entry.get(k) for k in ("Units", "RatificationStatus", "Source", "Duration", "SensorContract") if entry.get(k) is not None}
        status = entry.get("RatificationStatus")
        if status is not None:
            status = str(status).strip() or None
        rows.append({"connector_id": connector_id, "station_id": station_id, "timeseries_id": timeseries_id, "observed_at": observed.isoformat(), "value": value, "status": status, "metadata": meta, "species": species})
        if last_at is None or observed > last_at:
            last_at = observed; last_value = value
    return rows, nulls, (last_at.isoformat() if last_at else None), last_value


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Ingest Breathe London Nodes observations.")
    p.add_argument("--api-key", help="API key override; defaults to BLONDON_NODES_API_KEY.")
    p.add_argument("--start-time", help="Manual UTC start time; normal runs use checkpoints and connector poll_window_hours.")
    p.add_argument("--end-time", help="Manual UTC end time; default now UTC.")
    p.add_argument("--site-code", help="Limit to one SiteCode/station_ref.")
    p.add_argument("--species", help="Comma-separated species (default: PM25,NO2,PM25Index,NO2Index).")
    p.add_argument("--dry-run", action="store_true", help="Fetch/build rows without Supabase writes or Pub/Sub publishes.")
    p.add_argument("--max-stations", type=int, help="Safety limit for station count.")
    p.add_argument("--max-api-calls", type=int, help="Safety limit for /SensorData calls.")
    p.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    p.add_argument("--sleep-seconds", type=float, default=DEFAULT_SLEEP_SECONDS)
    p.add_argument("--overlap-minutes", type=int, default=DEFAULT_OVERLAP_MINUTES)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    species = parse_species(args.species)
    if not species:
        raise SystemExit("No valid species selected.")
    api_key = (args.api_key or os.getenv("BLONDON_NODES_API_KEY") or "").strip()
    if not api_key:
        raise SystemExit("BLONDON_NODES_API_KEY is required; no sensible default exists for an API credential.")
    writer = SupabaseWriter()
    connector = writer.fetch_connector()
    connector_id = int(connector["id"])
    if connector.get("poll_enabled") is False and not (args.start_time or args.site_code):
        LOG.info("Connector blondon_nodes poll_enabled=false; exiting normal scheduled run."); return 0
    stations = writer.fetch_active_stations(connector_id, args.site_code, args.max_stations)
    LOG.info("Loaded %s active blondon_nodes stations.", len(stations))
    if not stations:
        return 0
    phenomenon_ids = writer.upsert_phenomena(connector_id, species) if not args.dry_run else {}
    ts_rows = []
    for st in stations:
        station_ref = str(st["station_ref"])
        station_name = st.get("station_name") or st.get("label") or station_ref
        for sp in species:
            cfg = SPECIES_CONFIG[sp]
            ts_rows.append({"timeseries_ref": f"{station_ref}:{sp}", "label": f"{station_name} {cfg['label']}", "uom": cfg["uom"], "station_id": int(st["id"]), "service_ref": SERVICE_REF, "connector_id": connector_id, "phenomenon_id": phenomenon_ids.get(cfg["source_label"]), "extras": {"site_code": station_ref, "species": sp, "measurement_kind": cfg["kind"], "api_units": cfg["uom"]}})
    ts_ids = writer.upsert_timeseries(ts_rows) if not args.dry_run else {r["timeseries_ref"]: -i-1 for i, r in enumerate(ts_rows)}
    checkpoints = writer.fetch_checkpoints([int(s["id"]) for s in stations], species) if not args.dry_run else {}
    client = BreatheLondonNodesClient(api_key)
    observs_writer = ObservsWriter(writer.client)
    end_time = floor_to_minute(parse_iso(args.end_time) or utcnow())
    poll_hours = float(connector.get("poll_window_hours") or 6)
    default_start = end_time - timedelta(hours=max(poll_hours, 0.1))
    explicit_start = parse_iso(args.start_time)
    api_calls = observations = null_values_skipped = empty_series = pub_obs = pub_latest = 0
    checkpoint_rows = []
    latest_updates: Dict[int, Dict[str, Any]] = {}
    for st in stations:
        station_ref = str(st["station_ref"]); station_id = int(st["id"])
        for sp in species:
            if args.max_api_calls is not None and api_calls >= args.max_api_calls:
                LOG.warning("Stopping at --max-api-calls=%s", args.max_api_calls); break
            ts_ref = f"{station_ref}:{sp}"; ts_id = ts_ids.get(ts_ref)
            cp = checkpoints.get((station_id, sp), {})
            cp_last = parse_iso(cp.get("last_observed_at"))
            start_time = explicit_start or max((cp_last - timedelta(minutes=max(args.overlap_minutes, 0))) if cp_last else default_start, default_start)
            start_time = floor_to_minute(start_time)
            last_error = None
            last_at = None
            last_value = None
            try:
                payload = client.sensor_data(station_ref, sp, start_time, end_time); api_calls += 1
                if not payload:
                    empty_series += 1
                rows, nulls, last_at, last_value = build_rows(payload, int(ts_id), connector_id, station_id, sp)
                null_values_skipped += nulls
                observations += len(rows)
                if rows and not args.dry_run:
                    for rows_chunk in [rows[i:i+args.batch_size] for i in range(0, len(rows), args.batch_size)]:
                        writer.upsert_observations(rows_chunk)
                        written, latest = observs_writer.write(rows_chunk)
                        pub_obs += written
                        pub_latest += latest
                    if last_at and last_value is not None:
                        latest_updates[int(ts_id)] = {"timeseries_id": int(ts_id), "observed_at": last_at, "value": last_value}
            except Exception as exc:
                last_error = str(exc)
                LOG.warning("Failed %s %s: %s", station_ref, sp, exc)
            checkpoint_rows.append({"station_id": station_id, "species": sp, "timeseries_id": None if int(ts_id) < 0 else int(ts_id), "last_observed_at": last_at if last_at else cp.get("last_observed_at"), "last_polled_at": utcnow().isoformat(), "last_error": last_error, "updated_at": utcnow().isoformat()})
            if args.sleep_seconds:
                time.sleep(args.sleep_seconds)
        else:
            continue
        break
    if not args.dry_run:
        writer.update_timeseries_last_values(list(latest_updates.values()))
        writer.upsert_checkpoints(checkpoint_rows)
        writer.update_connector_last_polled(connector_id)
    LOG.info("Nodes ingest complete stations=%s species=%s api_calls=%s observations=%s null_values_skipped=%s empty_series=%s checkpoints=%s pubsub_observs=%s pubsub_latest=%s dry_run=%s", len(stations), len(species), api_calls, observations, null_values_skipped, empty_series, len(checkpoint_rows), pub_obs, pub_latest, args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
