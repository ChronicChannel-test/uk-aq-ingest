# Sensor.Community

This network uses Sensor.Community (formerly Luftdaten) for community air quality sensors.

## Source API
- **Read domain:** `https://data.sensor.community`
- **Endpoint used:** `/airrohr/v1/filter/country=GB`
- **User-Agent:** Set `SCOMM_USER_AGENT` to identify your client (Sensor.Community request guidance).

## Storage mapping
- Connector metadata is stored in `connectors` (`connector_code`: `sensorcommunity`).
- Stations are stored in `stations` with `connector_id`, `service_ref` (defaults to `sensorcommunity`), and `station_ref` based on the Sensor.Community sensor ID.
- Timeseries are created per station + pollutant (`pm10`, `pm2.5`), using `timeseries_ref` like `{station_ref}:{pollutant}` and the same `service_ref`.
- Phenomena rows are created for `pm10` and `pm2.5`, and `timeseries.phenomenon_id` is set accordingly.
- Observations are inserted into `observations` with the timestamp provided by Sensor.Community payloads.
- When `SCOMM_INGEST_MET_FIELDS=true`, temperature/humidity/pressure are ingested with their own timeseries.
- Ingest performs dual-write to history and main observations in parallel to reduce runtime.
- Timeseries phenomenon backfill for legacy nulls is handled by daily maintenance (`scripts/sensorcommunity/sensorcommunity_backfill_timeseries_phenomena.py`), not the ingest hot path.

## Connector creation
- Connector rows are created by the stations sync; the ingest expects the connector to exist and does not create it.

## Poll cadence
- Intended polling cadence: every 15 minutes at **:10, :25, :40, :55** (UTC).
- Runtime cadence is controlled by `connectors.poll_interval_minutes` in the dashboard.
- Scheduler path is controlled by `connectors.scheduler_backend`:
  - `supabase_function`: dispatcher runs `ingest_sensorcommunity`.
  - `google_cloud_run`: Cloud Run job `workers/uk_aq_sensorcommunity_cloud_run` runs it.
- Recommended setup for Cloud Run: keep scheduler frequency high (for example every 2 minutes) and let connector due-check enforce the interval.

## Logging
- `SCOMM_LOG_LEVEL` controls script verbosity (default: `INFO`).
- `SCOMM_INGEST_MET_FIELDS` controls whether met fields are ingested (default: `false`).
