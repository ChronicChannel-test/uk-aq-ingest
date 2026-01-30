# OpenAQ

This network uses OpenAQ's API to pull UK monitoring locations and latest values.

## Source API
- Base URL: `https://api.openaq.org/v3`
- API key required: set `OPENAQ_API_KEY` in Supabase secrets or `.env` for local scripts.

## Endpoints
- Locations (bbox): `GET /v3/locations?bbox=west,south,east,north&limit=1000&page=1`
- Latest values per location: `GET /v3/locations/{id}/latest?limit=1000`

## Storage mapping
- Connector metadata is stored in `connectors` (`connector_code`: `openaq`).
- Stations are stored in `stations` with:
  - `station_ref` = OpenAQ location id (string)
  - `label` = location name or fallback `OpenAQ {id}`
  - `station_name` = `{provider} {location name}` when provider is available (unless `overwrite_station_name=false`)
  - `provider` shortname mapping: `London Air Quality Network` -> `LAQN` in station_name prefix
  - `station_type` = `mobile` when `isMobile=true`, else `fixed`
  - `geometry` = point from `coordinates`
- Phenomena rows are created using `eionet_uri = openaq:{parameter}` and `pollutant_label` set to the OpenAQ parameter name.
- Timeseries rows use `timeseries_ref` = OpenAQ sensor id and `phenomenon_id` resolved from the parameter name.
- Observations are inserted for the latest values per sensor with `observed_at` from the OpenAQ payload.
- Edge ingest uses public RPCs for DB writes because `uk_aq_core`/`uk_aq_raw` are not exposed via PostgREST.

## Poll cadence
- Intended polling cadence: every 60 minutes with a 6-hour window (configurable via connector settings).
- Runtime budget: default 110s (`OPENAQ_MAX_RUNTIME_SECONDS`).
- Uses per-station scheduling in `uk_aq_raw.openaq_station_checkpoints` (next_due_at, last_observed_at, sample arrays).
- Tiered station selection: 50 overdue + 10 stale (configurable via `OPENAQ_TIERED_LIMIT`/`OPENAQ_STALE_LIMIT`).
- Uses OpenAQ rate-limit headers as a guardrail and stops issuing new requests when remaining is low.
- When `OPENAQ_INGEST_STATION_FETCH=true`, the ingest performs the bbox station fetch; otherwise it only polls latest values using cached metadata.

## Connector creation
- Connector rows are created by the stations sync (`scripts/openaq/openaq_list_stations.py`).
- The edge ingest expects the connector to exist and does not create it.

## Dropbox logging (optional)
- When Dropbox credentials and the OpenAQ allowlist env are set, `ingest_openaq` uploads:
  - Logs to `/connectors/openaq/log/YYYY-MM-DD/` with prefix `uk_aq_log_edge_openaq_`.
  - Raw payload ZIPs to `/connectors/openaq/raw_data/YYYY-MM-DD/` with prefix `uk_aq_raw_edge_openaq_`.
- Enable with `OPENAQ_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (or the shared `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`).
