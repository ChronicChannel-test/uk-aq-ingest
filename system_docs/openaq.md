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
  - `station_name` = `{provider} {location name} - {owner}` when owner is present and not `Unknown*`
    (falls back to `{provider} {location name}`; unless `overwrite_station_name=false`)
  - `provider` shortname mapping: `London Air Quality Network` -> `LAQN` in station_name prefix
  - `station_metadata.attributes.openaq_owner` stores the owner when it is present and not `Unknown*`
  - `station_type` = `mobile` when `isMobile=true`, else `fixed`
  - `geometry` = point from `coordinates`
- Phenomena rows are created using `source_label = openaq:{parameter}` and are mapped to canonical `observed_properties` codes/domains during upsert.
- Timeseries rows use `timeseries_ref` = OpenAQ sensor id and `phenomenon_id` resolved from the parameter name.
- Observations are inserted for the latest values per sensor with `observed_at` from the OpenAQ payload.
- Edge ingest uses public RPCs for DB writes because `uk_aq_core`/`uk_aq_raw` are not exposed via PostgREST.

## Poll cadence
- Intended polling cadence: every 60 minutes with a 6-hour window (configurable via connector settings).
- Runtime budget: default 120s (`OPENAQ_MAX_RUNTIME_SECONDS`).
- Uses per-station scheduling in `uk_aq_raw.openaq_station_checkpoints` (next_due_at, last_observed_at, sample arrays).
  `next_due_at` is set whenever `last_observed_at` advances. If either interval or lag has fewer
  than 10 samples, it is set to `now() + 5 minutes`. Otherwise it uses the last observed time plus
  the minimum interval (capped at 1 hour) and lag statistic selected by `OPENAQ_LAG_STAT`
  (`min` default, `median`, or `p25`). If no observations are returned and
  `next_due_at` is null, it is set to `now() + 5 minutes`.
- Tiered station selection: batch and stale caps are configurable via
  `OPENAQ_DEFAULT_BATCH_LIMIT` and `OPENAQ_STALE_LIMIT`, with tier1 re-poll guard
  configurable via `OPENAQ_TIER1_RETRY_SECONDS` (default 300s).
- Uses OpenAQ rate-limit headers as a guardrail and stops issuing new requests when remaining is low.
- Cloud Run wrapper applies an hourly request guard (`OPENAQ_MAX_REQUESTS_PER_HOUR`,
  default `1900`) using recent `uk_aq_ingest_runs.response_payload.requests_total`.
  When the hourly budget is exhausted before ingest starts, runs are recorded as `Skipped - Hourly Limit`
  and the next run is deferred to reset (or `OPENAQ_RATE_LIMIT_FALLBACK_SECONDS`,
  default 300s, when reset metadata is unavailable).
- Ingest now reserves a shared DB-backed OpenAQ token budget before each OpenAQ call
  (`OPENAQ_SHARED_BUDGET_ENFORCE=true` by default). This shared minute/hour budget is
  consumed by both Cloud Run ingest and OpenAQ station-sync scripts via
  `uk_aq_rpc_openaq_token_budget_reserve`.
- Non-hourly rate-limit/request-budget stops inside ingest are recorded as partial runs
  (not skipped) with reason fields in `run_message`/`stopped_reason`.
- Auth safety guard can auto-disable OpenAQ connector polling on `auth_401`/`auth_403`
  (`OPENAQ_AUTH_SAFETY_DISABLE_POLLING=true`) and clear queued self-tasks.
- When `OPENAQ_INGEST_STATION_FETCH=true`, the ingest performs the bbox station fetch; otherwise it only polls latest values using cached metadata.

## Connector creation
- Connector rows are created by the stations sync (`scripts/openaq/openaq_list_stations.py`).
- The edge ingest expects the connector to exist and does not create it.

## Dropbox logging (optional)
- When Dropbox credentials and the OpenAQ allowlist env are set, `ingest_openaq` uploads:
  - Logs to `/connectors/openaq/log/YYYY-MM-DD/` with runtime-aware prefix `uk_aq_log_<edge|cloud_run>_openaq_`.
  - Raw payload ZIPs to `/connectors/openaq/raw_data/YYYY-MM-DD/` with runtime-aware prefix `uk_aq_raw_<edge|cloud_run>_openaq_`.
- Enable with `OPENAQ_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (or the shared `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`).
- Runtime source is controlled by `OPENAQ_DROPBOX_UPLOAD_SOURCE` (defaults to `edge`; OpenAQ Cloud Run deploy sets `cloud_run`).
