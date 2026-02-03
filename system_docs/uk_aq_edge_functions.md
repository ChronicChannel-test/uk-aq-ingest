# UK AQ Edge Functions

This project uses Supabase Edge Functions for polling and serving data. The Edge
functions run inside Supabase and need their own environment variables (Project
Settings -> Functions -> Environment Variables). They do not read the local .env.

## Functions

### uk_aq_dispatch_polls
- Purpose: Dispatch due connector polls based on `connectors` scheduling fields.
- Triggered by: External scheduler (Cloudflare Worker cron) calling the edge function directly.
- Reads:
  - `connectors` (`poll_enabled`, `poll_interval_minutes`, `poll_window_hours`, `poll_timeseries_batch_size`, `last_polled_at`)
  - `dispatcher_settings` (`dispatcher_parallel_ingest`, `max_runs_per_dispatch_call`)
- Station batch helpers: `breathelondon_select_station_refs`, `erg_laqn_select_station_refs` (defined in `supabase/uk_aq_polling_helpers.sql`)
- Calls:
  - `ingest_uk_air_sos` (`window_hours`)
  - `ingest_sensorcommunity` (`country=GB`)
  - `ingest_openaq` (`window_hours`)
  - `ingest_breathelondon` (`station_refs`, `window_hours`, `initial_days=2`, `skip_stations=true`)
  - `ingest_erg_laqn` (`station_refs`, `days=ceil(poll_window_hours/24)`, `group=London`)
- Notes:
  - Requires `X-Cron-Secret` when `SB_UK_AQ_CRON_SECRET` is set.
  - Uses the Supabase service role key to read connector settings.
  - Uses `SB_ANON_JWT` (falls back to service role) to call ingest functions.
  - Only dispatches connectors with `poll_enabled=true` (null/false are skipped).
  - Dispatches one due connector per run, selecting the oldest `last_polled_at` (null first).
    - When `dispatcher_parallel_ingest` is true, dispatches up to `max_runs_per_dispatch_call` connectors per run (still max one per connector).
- Skips dispatch if any connector is in-flight (latest `uk_aq_ingest_runs` row has null `run_ended_at` within 10 minutes), and claims a connector slot before dispatch.
  - When `dispatcher_parallel_ingest` is true, in-flight checks are per connector; other connectors can still dispatch.
  - Stale in-flight runs (>10 minutes) are auto-closed as `failed` with `in_flight_timeout` and a `uk_aq_ingest_runs` row is inserted.
  - If a connector has `last_run_end` null but the latest `uk_aq_ingest_runs` row has `run_ended_at`, the connector row is reconciled as `ingest_runs_reconciled`.
  - Cloudflare worker cron runs every 2 minutes (`workers/uk_aq_dispatcher/wrangler.toml`).
  - For `uk_air_sos`, uses `poll_timeseries_batch_size` with `uk_air_sos_select_timeseries_ids` (`uk_air_sos_timeseries_checkpoints`) and passes `timeseries_ids`/`timeseries_limit`.
  - Uses `uk_aq_public.uk_aq_rpc_dispatch_claim` to atomically claim a connector slot before dispatch.
  - Updates `connectors.last_run_start`, `last_run_end`, `last_run_status`, `last_run_message`, and `last_polled_at` for each attempted dispatch.
  - Inserts per-run summaries into `uk_aq_ingest_runs` (status, counts, last_observed_at, response payload) for dashboard feeds.
  - Stores `series_polled` from ingest responses when available (used by OpenAQ and Breathe London).
  - Logs whether the cron secret is present (boolean + length) for debugging.
  - Logs each dispatched edge call with the target function name and cron secret presence (length only).
  - Writes dispatch errors to `error_logs`.

### ingest_uk_air_sos
- Purpose: Poll UK-AIR SOS timeseries and write observations + last_value fields.
- Triggered by: `uk_aq_dispatch_polls` (external scheduler). Helper RPCs live in `supabase/uk_aq_polling_helpers.sql`.
- Note: Deploying the Edge Function does not create a schedule; use the Cloudflare Worker cron for regular runs.
- Notes:
  - Requires an existing connector row; the ingest does not create connectors.
  - Logs cron secret mismatch diagnostics (presence/length only) when authorization fails.
  - Skips timeseries with missing `last_value_at` or `last_value_at` older than the poll window.
  - Enforces a runtime budget and will return partial progress with `partial=true` when exceeded.
  - Dedupes observations by `observed_at` per timeseries before upsert to avoid duplicate conflict errors.
- Writes:
  - `observations` (upsert by connector_id + timeseries_id + observed_at)
  - `timeseries.last_value` and `timeseries.last_value_at` (update by id)
- Logs:
  - Writes a log file to Dropbox `/connectors/uk_air_sos/log/YYYY-MM-DD/`
  - Writes raw payloads to Dropbox `/connectors/uk_air_sos/raw_data/YYYY-MM-DD/` as ZIP
  - Writes errors to `error_logs` and `/error_log/YYYY-MM-DD/`
  - Logs a "No datapoints parsed" warning with row count when the SOS payload has no rows.

### ingest_sensorcommunity
- Purpose: Poll Sensor.Community recent values and write stations, timeseries, and observations.
- Triggered by: `uk_aq_dispatch_polls` (external scheduler). Helper RPCs live in `supabase/uk_aq_polling_helpers.sql`.
- Writes:
  - `connectors` (last_polled_at updates), `stations`, `phenomena`, `timeseries`, `observations`
- Notes:
  - Requires an existing connector row; the ingest does not create connectors.
  - Uses `SCOMM_*` environment variables for base URL, service metadata, and country.
  - `SCOMM_INGEST_MET_FIELDS=true` enables temperature/humidity/pressure ingestion.
  - Filters to the UK bounding box by default; stations with missing coordinates are kept.
  - Sets `stations.station_exposure` to `indoor`/`outdoor` when `location.indoor` is present (0/1 or boolean).
  - Honors `connectors.overwrite_station_name` to decide when `stations.station_name` can be overwritten (false keeps existing non-null names).
  - Enforces a runtime budget and will return partial progress with `partial=true` when exceeded.
- Logs:
  - Writes a log file to Dropbox `/connectors/sensorcommunity/log/YYYY-MM-DD/` (prefix `uk_aq_log_edge_scomm_`).
  - Writes raw payloads to Dropbox `/connectors/sensorcommunity/raw_data/YYYY-MM-DD/` as ZIP (prefix `uk_aq_raw_edge_scomm_`).
  - Writes errors to `error_logs` and `/error_log/YYYY-MM-DD/`.

### ingest_openaq
- Purpose: Poll OpenAQ locations within the UK bounding box and write stations, timeseries, and observations.
- Triggered by: `uk_aq_dispatch_polls` (external scheduler).
- Writes:
  - `stations`, `phenomena`, `timeseries`, `observations`
  - `openaq_station_checkpoints`, `openaq_timeseries_checkpoints`
- Notes:
  - Requires an existing connector row; the ingest does not create connectors.
  - Uses `OPENAQ_*` environment variables for base URL, API key, and bbox paging.
  - Fetches locations via `/v3/locations` (bbox) and latest values via `/v3/locations/{id}/latest`.
  - Performs a pre-call gap check using `now() > last_observed_at + 2 hours` from station checkpoints; when true, polls `/v3/sensors/{id}/measurements/hourly` instead of `/latest` for that station.
  - When `locations_fetched=false`, loads timeseries refs for all selected stations via `uk_aq_rpc_timeseries_refs_by_station_ids` so timeseries checkpoints can always be updated.
  - Uses sensor IDs as `timeseries_ref` and `openaq:{parameter}` as `phenomena.eionet_uri`.
  - If `station_refs` are provided, limits polling to those location ids; otherwise uses a tiered selector (`uk_aq_rpc_openaq_select_station_refs`) that returns both station refs and station ids.
  - Tracks per-station scheduling in `uk_aq_raw.openaq_station_checkpoints` (next due, last observed, sample arrays, last polled); when fewer than 10 interval/lag samples exist, `next_due_at` is set to `now() + 5 minutes`. Otherwise it uses the minimum interval (capped at 1 hour) plus minimum lag from samples. If no observations are returned and `next_due_at` is null, it is set to `now() + 5 minutes`.
  - Tracks per-timeseries scheduling in `uk_aq_raw.openaq_timeseries_checkpoints` (next due, last observed, lag samples, last polled); when fewer than 10 lag samples exist, `next_due_at` is set to `now() + 5 minutes`. Otherwise it uses `last_observed_at + 3600s + min(lag)` and only updates `next_due_at` on new observations or when null.
  - Station names are prefixed with provider shortnames when configured (e.g., `London Air Quality Network` -> `LAQN`), and append owner when present and not `Unknown*`.
  - Stores OpenAQ owner in `station_metadata.attributes.openaq_owner` when present and not `Unknown*`.
  - Updates `timeseries.last_value` and `timeseries.last_value_at` based on the most recent measurement.
  - Uses public RPCs for database writes (schemas are not exposed via PostgREST).
  - Enforces a runtime budget (default 110s) and returns `partial=true` when exceeded.
  - Requires `X-Cron-Secret` when `SB_UK_AQ_CRON_SECRET` is set.
  - Stops issuing new requests when rate-limit remaining drops below the threshold (default 5) or on HTTP 429.
- Logs:
  - Writes a log file to Dropbox `/connectors/openaq/log/YYYY-MM-DD/` (prefix `uk_aq_log_edge_openaq_`).
  - Writes raw payloads to Dropbox `/connectors/openaq/raw_data/YYYY-MM-DD/` as ZIP (prefix `uk_aq_raw_edge_openaq_`).
  - Writes diagnostic entries to `error_logs` when Dropbox config is missing/mismatched or log/raw uploads fail.
  - Logs timeseries mapping diagnostics (missing refs/station ids samples) to aid checkpoint debugging.

### ingest_breathelondon
- Purpose: Poll Breathe London Communities for hourly observations with checkpointing.
- Triggered by: `uk_aq_dispatch_polls` (external scheduler). Helper RPCs live in `supabase/uk_aq_polling_helpers.sql`.
- Writes:
  - `connectors` (last_polled_at updates), `stations`, `phenomena`, `timeseries`, `observations`
  - `breathelondon_station_checkpoints` (per-station checkpoints)
- Notes:
  - Requires an existing connector row; the ingest does not create connectors.
  - Uses `BREATHELONDON_API_KEY` for every request.
  - Supports `skip_stations` to avoid station upserts; when set, stations are loaded from Supabase instead of `ListSensors`.
  - Supports `active_only` to limit polling to stations marked `enabled` or `site_active` in metadata.
- Supports `station_refs` to limit polling to a specific set of station refs.
- Uses `uk_aq_raw.breathelondon_station_checkpoints` for per-station scheduling (`next_due_at`, `ingest_lag_samples`).
- Supports `debug=true` to include a debug block in the response (Dropbox config status, no secrets).
  - Logs cron secret mismatch diagnostics (presence/length only) when authorization fails.
  - Logs incoming request auth header presence (no secrets) for debugging.
  - Response includes `stations_requested`/`stations_selected` when station refs are supplied.
  - Response includes `series_polled` (timeseries with last-value updates during the run).
  - Enforces a runtime budget and will return partial progress with `partial=true` when exceeded.
  - Updates `connectors.last_polled_at` on successful non-dry runs.
- Logs:
  - Writes a log file to Dropbox `/connectors/breathelondon/log/YYYY-MM-DD/` (prefix `uk_aq_log_edge_breathelondon_`).
  - Writes raw payloads to Dropbox `/connectors/breathelondon/raw_data/YYYY-MM-DD/` as ZIP (prefix `uk_aq_raw_edge_breathelondon_`).
  - Writes errors to `error_logs` and `/error_log/YYYY-MM-DD/` when Dropbox error logging is configured.
  - Writes diagnostic entries to `error_logs` when Dropbox config is missing/mismatched or log/raw uploads fail.

### ingest_erg_laqn
- Purpose: Poll ERG LAQN (configurable group, default London) and write observations.
- Triggered by: `uk_aq_dispatch_polls` (external scheduler). Helper RPCs live in `supabase/uk_aq_polling_helpers.sql`.
- Writes:
  - `connectors`, `stations`, `phenomena`, `timeseries`, `observations`
  - `timeseries.last_value` and `timeseries.last_value_at` (update by id)
  - `connectors.last_polled_at` (update by id)
  - `erg_laqn_station_checkpoints` (update by station_id)
- Notes:
  - Requires an existing connector row; the ingest does not create connectors.
  - Request body supports `group`, `station_refs`, `species`, `days`, `start_date`, `end_date`, `batch_size`, `sleep_seconds`, `dry_run`, `csv_station_id`, and `csv_station_ref`.
  - Uses `/Information/MonitoringSites/GroupName={group}/Json` for stations.
  - Uses `/Data/SiteSpecies/SiteCode={code}/SpeciesCode={species}/StartDate={YYYY-MM-DD}/EndDate={YYYY-MM-DD}/Json` for raw data.
  - Dates are treated as UTC/GMT; when `end_date` is omitted, the edge function sets `EndDate` to tomorrow's UTC date so "today" is included.
  - Skips per-site/species ERG responses that return HTTP 400 (logs a warning; continues).
  - Includes zero-valued observations (no zero-value filtering).
  - When `start_from_latest=true`, uses `timeseries.last_value_at` to extend the per-series start date if the latest value is older than the requested start date.
  - Logs a warning when a site/species fetch returns data older than UTC midnight for the current day.
  - When CSV settings are configured, uploads a daily CSV per pollutant to Dropbox using a fixed station (see env vars).
  - Enforces a runtime budget and will return partial progress with `partial=true` when exceeded.
- Logs:
  - Writes a log file to Dropbox `/connectors/erg_laqn/log/YYYY-MM-DD/` (prefix `uk_aq_log_edge_erg_laqn_`).
  - Writes raw payloads to Dropbox `/connectors/erg_laqn/raw_data/YYYY-MM-DD/` as ZIP (prefix `uk_aq_raw_edge_erg_laqn_`).
  - Writes errors to `error_logs` and `/error_log/YYYY-MM-DD/` when Dropbox error logging is configured.

### uk_aq_latest
- Purpose: Serve the latest values across all stations (optionally filtered by region/station/pollutant).
- Triggered by: Web requests (read-only, no writes).
- Returns: timeseries rows with station + phenomenon metadata, connector metadata (`connector_id`, `connector_code`, `connector_label` from `connectors.display_name`), `display_name`, latest values, and `station_network_memberships` (network_code, network_label, is_primary). Station payload includes `la_code`/`la_version` when present.
- Params: `region`, `station_like`, `pollutant`, `connector_id`, `limit`, `pcon_code`.
- Notes:
  - Explicitly embeds `connectors` via `timeseries_connector_id_fkey` to avoid ambiguous PostgREST relationships after observations gained `connector_id`.
- RPC backing: `uk_aq_latest_rpc` via `/rest/v1/rpc/uk_aq_latest_rpc`.
- Cache-Control: success responses use `public, max-age=60, s-maxage=180, stale-while-revalidate=300, stale-if-error=86400`; errors use `no-store`.
- Memberships are returned as-is (no filtering by network membership).
- `display_name` logic:
  - Uses `connectors.station_display_name_template` if present, with tokens `{station_name}`, `{station_label}`, `{station_ref}`.
  - Fallback is always `{station_name} - {station_ref}` (or `station_label` if `station_name` is missing).

Curl test example:
```bash
curl "https://YOUR_PROJECT.supabase.co/functions/v1/uk_aq_latest?region=London&pollutant=pm2.5&limit=100"
```

### uk_aq_bristol_latest
- Purpose: Serve the latest values with a Bristol station default for local dashboards.
- Triggered by: Web requests (read-only, no writes).
- Returns: timeseries rows with station + phenomenon metadata, `display_name`, and latest values.
- `display_name` logic matches `uk_aq_latest`.
- Cache-Control: success responses use `public, max-age=60, s-maxage=180, stale-while-revalidate=300, stale-if-error=86400`; errors use `no-store`.
- Notes:
  - Explicitly embeds `connectors` via `timeseries_connector_id_fkey` to avoid ambiguous PostgREST relationships after observations gained `connector_id`.

### uk_aq_stations
- Purpose: Serve station geometry for the hex map (bypasses RLS via service role).
- Triggered by: Web requests (read-only, no writes).
- Returns: stations with geometry (id, station_ref, label, geometry) plus `station_network_memberships` (network codes, labels, primary flag).

### uk_aq_la_hex
- Purpose: Serve LA-level latest PM2.5 summaries (median + mean) for the hex cartogram.
- Triggered by: Web requests (read-only, no writes).
- Returns: rows keyed by `la_code` with `station_count`, `single_site`, `median_value`, `mean_value`, `latest_value_at` (expands `la_codes` arrays into per-code rows when present).
- Params: `region`, `la_version`, `limit`.
- RPC backing: `uk_aq_la_hex_rpc` via `/rest/v1/rpc/uk_aq_la_hex_rpc`.
- Cache-Control: success responses use `public, max-age=60, s-maxage=180, stale-while-revalidate=300, stale-if-error=86400`; errors use `no-store`.

### uk_aq_pcon_hex
- Purpose: Serve constituency-level latest PM2.5 summaries (median + mean) for the hex cartogram.
- Triggered by: Web requests (read-only, no writes).
- Returns: rows keyed by `pcon_code` with `station_count`, `single_site`, `median_value`, `mean_value`, `latest_value_at`.
- Params: `pcon_version`, `limit`.
- RPC backing: `uk_aq_pcon_hex_rpc` via `/rest/v1/rpc/uk_aq_pcon_hex_rpc`.
- Cache-Control: success responses use `public, max-age=60, s-maxage=300, stale-while-revalidate=300, stale-if-error=86400`; errors use `no-store`.

### uk_aq_timeseries
- Purpose: Serve raw observation points for a single timeseries.
- Triggered by: Web requests (read-only, no writes).
- Params: `timeseries_id` (required), `window` (`12h|24h|7d|30d`, default `24h`), optional `limit`.
- Returns: `observed_at`, `value`, `status` rows ordered oldest → newest, plus optional `guideline` (AQG_2021 24h) if found.
- RPC backing: `uk_aq_timeseries_rpc` via `/rest/v1/rpc/uk_aq_timeseries_rpc`.
- Cache-Control: success responses use `public, max-age=60, s-maxage=300, stale-while-revalidate=300, stale-if-error=86400`; errors use `no-store`.

Curl test example (shape check):
```bash
curl "https://YOUR_PROJECT.supabase.co/functions/v1/uk_aq_timeseries?timeseries_id=123&window=24h"
curl "https://YOUR_PROJECT.supabase.co/functions/v1/uk_aq_timeseries?timeseries_id=123&window=7d"
```

## Environment variables (Supabase Edge)

Required:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `BREATHELONDON_API_KEY` (required for `ingest_breathelondon`)

Dropbox (raw/log/error uploads):
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

Dropbox folders:
  - `UK_AQ_DROPBOX_ROOT` (e.g., `/CIC-Test` or `/LIVE`)
- `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (required to enable raw uploads)
- `OPENAQ_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (optional allowlist override for OpenAQ)
- `BREATHELONDON_DROPBOX_ROOT` (optional override for Breathe London)
- `BREATHELONDON_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (optional allowlist override for Breathe London)
- `BREATHELONDON_ERROR_DROPBOX_ALLOWED_SUPABASE_URL` (optional allowlist override for Breathe London error uploads)
- `SCOMM_DROPBOX_ROOT` (optional override for Sensor.Community)
- `SCOMM_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (optional allowlist override for Sensor.Community)

Optional:
- `UK_AQ_CORE_SCHEMA` (defaults to `uk_aq_core`; used for PostgREST profile headers)
- `UK_AQ_RAW_SCHEMA` (defaults to `uk_aq_raw`; used for raw tables like `error_logs` and checkpoint tables)
- `UK_AIR_ERROR_DROPBOX_FOLDER` (defaults to `error_log`)
- `BREATHELONDON_ERROR_DROPBOX_FOLDER` (optional override for Breathe London)
- `SCOMM_ERROR_DROPBOX_FOLDER` (optional override for Sensor.Community)
- `SCOMM_ERROR_DROPBOX_ALLOWED_SUPABASE_URL` (optional allowlist for Sensor.Community error uploads)
- `SCOMM_INGEST_MET_FIELDS` (defaults to `false`; set `true` to ingest temperature/humidity/pressure)
- `SCOMM_MAX_RUNTIME_SECONDS` (optional; defaults to 110)
- `OPENAQ_BASE_URL` (optional; defaults to `https://api.openaq.org/v3`)
- `OPENAQ_API_KEY` (required for `ingest_openaq`)
- `OPENAQ_CONNECTOR_CODE` (optional; defaults to `openaq`)
- `OPENAQ_SERVICE_REF` (optional; defaults to `OPENAQ_CONNECTOR_CODE`)
- `OPENAQ_SERVICE_LABEL` (optional; defaults to `OpenAQ`)
- `OPENAQ_USER_AGENT` (optional; defaults to `uk-air-quality-networks`)
- `OPENAQ_BBOX` (optional; defaults to `-8.623555,49.863222,1.763337,60.871222`)
- `OPENAQ_PAGE_LIMIT` (optional; defaults to `1000`)
- `OPENAQ_MAX_PAGES` (optional; defaults to `50`)
- `OPENAQ_CONCURRENCY` (optional; defaults to `6`)
- `OPENAQ_MAX_RUNTIME_SECONDS` (optional; defaults to `110`)
- `OPENAQ_RATE_LIMIT_RETRIES` (optional; defaults to `3`)
- `OPENAQ_INGEST_STATION_FETCH` (optional; defaults to `false`)
- `OPENAQ_TIERED_LIMIT` (optional; defaults to `50`)
- `OPENAQ_STALE_LIMIT` (optional; defaults to `10`)
- `OPENAQ_RATE_LIMIT_STOP_THRESHOLD` (optional; defaults to `5`)
- `BREATHELONDON_BASE_URL` (optional override for Breathe London API base URL)
- `BREATHELONDON_CONNECTOR_CODE` / `BREATHELONDON_SERVICE_REF` (optional override)
- `BREATHELONDON_SERVICE_LABEL` (optional override)
- `BREATHELONDON_USER_AGENT` (optional override)
- `BREATHELONDON_MAX_RUNTIME_SECONDS` (optional; defaults to 110)
- `LAQN_BASE_URL` (optional override for ERG LAQN API base URL)
- `LAQN_CONNECTOR_CODE` / `LAQN_SERVICE_REF` (optional override)
- `LAQN_CONNECTOR_LABEL` (optional override, `LAQN_SERVICE_LABEL` also accepted)
- `LAQN_CONNECTOR_DISPLAY_NAME` (optional override)
- `LAQN_USER_AGENT` (optional override)
- `LAQN_DEFAULT_GROUP` (optional override, default `London`)
- `LAQN_CSV_STATION_ID` / `LAQN_CSV_STATION_REF` (optional station selection for daily CSV uploads)
- `LAQN_CSV_DROPBOX_FOLDER` (optional override for ERG LAQN daily CSV folder; default `/connectors/erg_laqn`)
- `LAQN_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (optional allowlist override for ERG LAQN raw uploads)
- `LAQN_ERROR_DROPBOX_ALLOWED_SUPABASE_URL` (optional allowlist override for ERG LAQN error uploads)
- `LAQN_ERROR_DROPBOX_FOLDER` (optional override for ERG LAQN error folder)
- `LAQN_MAX_RUNTIME_SECONDS` (optional; defaults to 110)
- `UK_AIR_SOS_MAX_RUNTIME_SECONDS` (optional; defaults to 110)
- `SB_UK_AQ_CRON_SECRET` (when set, ingest functions require `X-Cron-Secret`)

## Notes

- `ingest_uk_air_sos` does not discover stations/timeseries; discovery happens in
  the Python ingest script (see `scripts/uk_air_sos/uk_air_sos_ingest.py`).
- `ingest_sensorcommunity` and `ingest_breathelondon` both upsert stations and
  timeseries as part of the poll.
- When `SB_UK_AQ_CRON_SECRET` is set, ingest functions require an `X-Cron-Secret`
  header that matches the secret.
- If `timeseries.station_id` is null, joins to stations will not work correctly.
  Run the discovery step to populate station links.
- Edge functions send `Accept-Profile` / `Content-Profile` headers for core/raw
  schemas (core by default; raw for `error_logs` and checkpoint tables). RPC calls
  in `uk_aq_dispatch_polls` target the `public` schema.
