# UK AQ Edge Functions

This project uses Supabase Edge Functions for polling and serving data. The Edge
functions run inside Supabase and need their own environment variables (Project
Settings -> Functions -> Environment Variables). They do not read the local .env.

## Functions

### ingest_uk_air_sos
- Purpose: Poll UK-AIR SOS timeseries and write observations + last_value fields.
- Triggered by: Supabase cron (see `supabase/uk_aq_polling_cron.sql`).
- Note: Deploying the Edge Function does not create a schedule; the cron timing lives in `supabase/uk_aq_polling_cron.sql` and must be applied separately.
- Writes:
  - `observations` (upsert by timeseries_id + observed_at)
  - `timeseries.last_value` and `timeseries.last_value_at` (update by id)
- Logs:
  - Writes a log file to Dropbox `/log/YYYY-MM-DD/`
  - Writes raw payloads to Dropbox `/raw_data/YYYY-MM-DD/` as ZIP
  - Writes errors to `error_logs` and `/error_log/YYYY-MM-DD/`

### ingest_sensorcommunity
- Purpose: Poll Sensor.Community recent values and write stations, timeseries, and observations.
- Triggered by: Supabase cron (see `supabase/uk_aq_polling_cron.sql`).
- Writes:
  - `connectors`, `stations`, `phenomena`, `timeseries`, `observations`
- Notes:
  - Uses `SCOMM_*` environment variables for base URL, service metadata, and country.
  - `SCOMM_INGEST_MET_FIELDS=true` enables temperature/humidity/pressure ingestion.
  - Filters to the UK bounding box by default; stations with missing coordinates are kept.
  - Sets `stations.station_exposure` to `indoor`/`outdoor` when `location.indoor` is present (0/1 or boolean).
  - Honors `connectors.overwrite_station_name` to decide when `stations.station_name` can be overwritten (false keeps existing non-null names).
- Logs:
  - Writes a log file to Dropbox `/log/YYYY-MM-DD/` (prefix `uk_aq_log_edge_scomm_`).
  - Writes raw payloads to Dropbox `/raw_data/YYYY-MM-DD/` as ZIP (prefix `uk_aq_raw_edge_scomm_`).
  - Writes errors to `error_logs` and `/error_log/YYYY-MM-DD/`.

### uk_aq_latest
- Purpose: Serve the latest values across all stations (optionally filtered by region/station/pollutant).
- Triggered by: Web requests (read-only, no writes).
- Returns: timeseries rows with station + phenomenon metadata, connector metadata (`connector_id`, `connector_code`, `connector_label`), `display_name`, and latest values.
- Params: `region`, `station_like`, `pollutant`, `connector_id`, `limit`, `pcon_code`.
- `display_name` logic:
  - Uses `connectors.display_name_template` if present, with tokens `{station_name}`, `{station_label}`, `{station_ref}`.
  - Fallback is always `{station_name} - {station_ref}` (or `station_label` if `station_name` is missing).

### uk_aq_bristol_latest
- Purpose: Serve the latest values with a Bristol station default for local dashboards.
- Triggered by: Web requests (read-only, no writes).
- Returns: timeseries rows with station + phenomenon metadata, `display_name`, and latest values.
- `display_name` logic matches `uk_aq_latest`.

### uk_aq_stations
- Purpose: Serve station geometry for the hex map (bypasses RLS via service role).
- Triggered by: Web requests (read-only, no writes).
- Returns: stations with geometry (id, station_ref, label, geometry) plus `station_network_memberships` (network codes, labels, primary flag).

### uk_aq_la_hex
- Purpose: Serve LA-level latest PM2.5 summaries (median + mean) for the hex cartogram.
- Triggered by: Web requests (read-only, no writes).
- Returns: rows keyed by `la_code` with `station_count`, `single_site`, `median_value`, `mean_value`, `latest_value_at`.

### uk_aq_pcon_hex
- Purpose: Serve constituency-level latest PM2.5 summaries (median + mean) for the hex cartogram.
- Triggered by: Web requests (read-only, no writes).
- Returns: rows keyed by `pcon_code` with `station_count`, `single_site`, `median_value`, `mean_value`, `latest_value_at`.

### uk_aq_timeseries
- Purpose: Serve raw observation points for a single timeseries.
- Triggered by: Web requests (read-only, no writes).
- Params: `timeseries_id` (required), `window` (`12h|24h|7d|30d`, default `24h`), optional `limit`.
- Returns: `observed_at`, `value`, `status` rows ordered oldest → newest, plus optional `guideline` (AQG_2021 24h) if found.

## Environment variables (Supabase Edge)

Required:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Dropbox (raw/log/error uploads):
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

Dropbox folders:
  - `UK_AQ_DROPBOX_ROOT` (e.g., `/CIC-Test` or `/LIVE`)
- `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (required to enable raw uploads)
- `SCOMM_DROPBOX_ROOT` (optional override for Sensor.Community)
- `SCOMM_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (optional allowlist override for Sensor.Community)

Optional:
- `UK_AIR_ERROR_DROPBOX_FOLDER` (defaults to `error_log`)
- `SCOMM_ERROR_DROPBOX_FOLDER` (optional override for Sensor.Community)
- `SCOMM_ERROR_DROPBOX_ALLOWED_SUPABASE_URL` (optional allowlist for Sensor.Community error uploads)
- `SCOMM_INGEST_MET_FIELDS` (defaults to `false`; set `true` to ingest temperature/humidity/pressure)

## Notes

- Edge functions do not discover stations/timeseries. Discovery happens in the
  Python ingest script (see `scripts/uk_air_sos/uk_air_sos_ingest.py`).
- If `timeseries.station_id` is null, joins to stations will not work correctly.
  Run the discovery step to populate station links.
