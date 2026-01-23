# UK AQ Edge Functions

This project uses Supabase Edge Functions for polling and serving data. The Edge
functions run inside Supabase and need their own environment variables (Project
Settings -> Functions -> Environment Variables). They do not read the local .env.

## Functions

### ingest_uk_air_sos
- Purpose: Poll UK-AIR SOS timeseries and write observations + last_value fields.
- Triggered by: Supabase cron dispatcher (`uk_air_sos_dispatch_poll` in `supabase/uk_aq_polling_cron.sql`), which skips when `connectors.poll_enabled` is false.
- Note: Deploying the Edge Function does not create a schedule; the cron timing lives in `supabase/uk_aq_polling_cron.sql` and must be applied separately.
- Writes:
  - `observations` (upsert by timeseries_id + observed_at)
  - `timeseries.last_value` and `timeseries.last_value_at` (update by id)
- Logs:
  - Writes a log file to Dropbox `/connectors/uk_air_sos/log/YYYY-MM-DD/`
  - Writes raw payloads to Dropbox `/connectors/uk_air_sos/raw_data/YYYY-MM-DD/` as ZIP
  - Writes errors to `error_logs` and `/error_log/YYYY-MM-DD/`

### ingest_sensorcommunity
- Purpose: Poll Sensor.Community recent values and write stations, timeseries, and observations.
- Triggered by: Supabase cron dispatcher (`sensorcommunity_dispatch_poll` in `supabase/uk_aq_polling_cron.sql`), which skips when `connectors.poll_enabled` is false.
- Writes:
  - `connectors`, `stations`, `phenomena`, `timeseries`, `observations`
- Notes:
  - Uses `SCOMM_*` environment variables for base URL, service metadata, and country.
  - `SCOMM_INGEST_MET_FIELDS=true` enables temperature/humidity/pressure ingestion.
  - Filters to the UK bounding box by default; stations with missing coordinates are kept.
  - Sets `stations.station_exposure` to `indoor`/`outdoor` when `location.indoor` is present (0/1 or boolean).
  - Honors `connectors.overwrite_station_name` to decide when `stations.station_name` can be overwritten (false keeps existing non-null names).
- Logs:
  - Writes a log file to Dropbox `/connectors/sensorcommunity/log/YYYY-MM-DD/` (prefix `uk_aq_log_edge_scomm_`).
  - Writes raw payloads to Dropbox `/connectors/sensorcommunity/raw_data/YYYY-MM-DD/` as ZIP (prefix `uk_aq_raw_edge_scomm_`).
  - Writes errors to `error_logs` and `/error_log/YYYY-MM-DD/`.

### ingest_breathelondon
- Purpose: Poll Breathe London Communities for hourly observations with checkpointing.
- Triggered by: Supabase cron batcher (`breathelondon_dispatch_batch` in `supabase/uk_aq_polling_cron.sql`), which skips when `connectors.poll_enabled` is false.
- Writes:
  - `connectors`, `stations`, `phenomena`, `timeseries`, `observations`
  - `breathelondon_timeseries_checkpoints` (per-station/species checkpoints)
- Notes:
  - Uses `BREATHELONDON_API_KEY` for every request.
  - Supports `skip_stations` to avoid station upserts; when set, stations are loaded from Supabase instead of `ListSensors`.
  - Supports `active_only` to limit polling to stations marked `enabled` or `site_active` in metadata.
  - Supports `station_refs` to limit polling to a specific set of station refs.
  - Supports `debug=true` to include a debug block in the response (Dropbox config status, no secrets).
  - Response includes `stations_requested`/`stations_selected` when station refs are supplied.
  - Updates `connectors.last_polled_at` on successful non-dry runs.
- Logs:
  - Writes a log file to Dropbox `/connectors/breathelondon/log/YYYY-MM-DD/` (prefix `uk_aq_log_edge_breathelondon_`).
  - Writes raw payloads to Dropbox `/connectors/breathelondon/raw_data/YYYY-MM-DD/` as ZIP (prefix `uk_aq_raw_edge_breathelondon_`).
  - Writes errors to `error_logs` and `/error_log/YYYY-MM-DD/` when Dropbox error logging is configured.
  - Writes diagnostic entries to `error_logs` when Dropbox config is missing/mismatched or log/raw uploads fail.

### ingest_erg_laqn
- Purpose: Poll ERG LAQN (configurable group, default London) and write observations.
- Triggered by: Supabase cron batcher (`erg_laqn_dispatch_batch` in `supabase/uk_aq_polling_cron.sql`), which skips when `connectors.poll_enabled` is false.
- Writes:
  - `connectors`, `stations`, `phenomena`, `timeseries`, `observations`
  - `timeseries.last_value` and `timeseries.last_value_at` (update by id)
  - `connectors.last_polled_at` (update by id)
  - `erg_laqn_station_checkpoints` (update by station_id)
- Notes:
  - Request body supports `group`, `station_refs`, `species`, `days`, `start_date`, `end_date`, `batch_size`, `sleep_seconds`, and `dry_run`.
  - Uses `/Information/MonitoringSites/GroupName={group}/Json` for stations.
  - Uses `/Data/SiteSpecies/SiteCode={code}/SpeciesCode={species}/StartDate={YYYY-MM-DD}/EndDate={YYYY-MM-DD}/Json` for raw data.
- Logs:
  - Writes a log file to Dropbox `/connectors/erg_laqn/log/YYYY-MM-DD/` (prefix `uk_aq_log_edge_erg_laqn_`).
  - Writes raw payloads to Dropbox `/connectors/erg_laqn/raw_data/YYYY-MM-DD/` as ZIP (prefix `uk_aq_raw_edge_erg_laqn_`).
  - Writes errors to `error_logs` and `/error_log/YYYY-MM-DD/` when Dropbox error logging is configured.

### uk_aq_latest
- Purpose: Serve the latest values across all stations (optionally filtered by region/station/pollutant).
- Triggered by: Web requests (read-only, no writes).
- Returns: timeseries rows with station + phenomenon metadata, connector metadata (`connector_id`, `connector_code`, `connector_label` from `connectors.display_name`), `display_name`, latest values, and `station_network_memberships` (network_code, network_label, is_primary).
- Params: `region`, `station_like`, `pollutant`, `connector_id`, `limit`, `pcon_code`.
- Memberships are returned as-is (no filtering by network membership).
- `display_name` logic:
  - Uses `connectors.station_display_name_template` if present, with tokens `{station_name}`, `{station_label}`, `{station_ref}`.
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
- `BREATHELONDON_API_KEY` (required for `ingest_breathelondon`)

Dropbox (raw/log/error uploads):
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

Dropbox folders:
  - `UK_AQ_DROPBOX_ROOT` (e.g., `/CIC-Test` or `/LIVE`)
- `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (required to enable raw uploads)
- `BREATHELONDON_DROPBOX_ROOT` (optional override for Breathe London)
- `BREATHELONDON_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (optional allowlist override for Breathe London)
- `BREATHELONDON_ERROR_DROPBOX_ALLOWED_SUPABASE_URL` (optional allowlist override for Breathe London error uploads)
- `SCOMM_DROPBOX_ROOT` (optional override for Sensor.Community)
- `SCOMM_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (optional allowlist override for Sensor.Community)

Optional:
- `UK_AIR_ERROR_DROPBOX_FOLDER` (defaults to `error_log`)
- `BREATHELONDON_ERROR_DROPBOX_FOLDER` (optional override for Breathe London)
- `SCOMM_ERROR_DROPBOX_FOLDER` (optional override for Sensor.Community)
- `SCOMM_ERROR_DROPBOX_ALLOWED_SUPABASE_URL` (optional allowlist for Sensor.Community error uploads)
- `SCOMM_INGEST_MET_FIELDS` (defaults to `false`; set `true` to ingest temperature/humidity/pressure)
- `BREATHELONDON_BASE_URL` (optional override for Breathe London API base URL)
- `BREATHELONDON_CONNECTOR_CODE` / `BREATHELONDON_SERVICE_REF` (optional override)
- `BREATHELONDON_SERVICE_LABEL` (optional override)
- `BREATHELONDON_USER_AGENT` (optional override)
- `LAQN_BASE_URL` (optional override for ERG LAQN API base URL)
- `LAQN_CONNECTOR_CODE` / `LAQN_SERVICE_REF` (optional override)
- `LAQN_CONNECTOR_LABEL` (optional override, `LAQN_SERVICE_LABEL` also accepted)
- `LAQN_CONNECTOR_DISPLAY_NAME` (optional override)
- `LAQN_USER_AGENT` (optional override)
- `LAQN_DEFAULT_GROUP` (optional override, default `London`)
- `LAQN_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (optional allowlist override for ERG LAQN raw uploads)
- `LAQN_ERROR_DROPBOX_ALLOWED_SUPABASE_URL` (optional allowlist override for ERG LAQN error uploads)
- `LAQN_ERROR_DROPBOX_FOLDER` (optional override for ERG LAQN error folder)
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
