# UK AQ Edge Functions

This project uses Supabase Edge Functions for polling and serving data. The Edge
functions run inside Supabase and need their own environment variables (Project
Settings -> Functions -> Environment Variables). They do not read the local .env.

## Functions

### ingest_uk_air_sos
- Purpose: Poll UK-AIR SOS timeseries and write observations + last_value fields.
- Triggered by: Supabase cron (see `supabase/uk_aq_polling_cron.sql`).
- Writes:
  - `observations` (upsert by timeseries_id + observed_at)
  - `timeseries.last_value` and `timeseries.last_value_at` (update by id)
- Logs:
  - Writes a log file to Dropbox `/log/YYYY-MM-DD/`
  - Writes raw payloads to Dropbox `/raw_data/YYYY-MM-DD/` as ZIP
  - Writes errors to `error_logs` and `/error_log/YYYY-MM-DD/`

### uk_aq_latest
- Purpose: Serve the latest values for a region/station filter.
- Triggered by: Web requests (read-only, no writes).
- Returns: timeseries rows with station + phenomenon metadata and latest values.

### uk_aq_stations
- Purpose: Serve station geometry for the hex map (bypasses RLS via service role).
- Triggered by: Web requests (read-only, no writes).
- Returns: stations with geometry (id, station_ref, label, geometry).

### uk_aq_la_hex
- Purpose: Serve LA-level latest PM2.5 summaries (median + mean) for the hex cartogram.
- Triggered by: Web requests (read-only, no writes).
- Returns: rows keyed by `la_code` with `station_count`, `single_site`, `median_value`, `mean_value`, `latest_value_at`.

### uk_aq_pcon_hex
- Purpose: Serve constituency-level latest PM2.5 summaries (median + mean) for the hex cartogram.
- Triggered by: Web requests (read-only, no writes).
- Returns: rows keyed by `pcon_code` with `station_count`, `single_site`, `median_value`, `mean_value`, `latest_value_at`.

## Environment variables (Supabase Edge)

Required:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Dropbox (raw/log/error uploads):
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

Dropbox folders:
- `UK_AIR_DROPBOX_ROOT` (e.g., `/CIC-Test` or `/LIVE`)
- `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (required to enable raw uploads)

Optional:
- `UK_AIR_ERROR_DROPBOX_FOLDER` (defaults to `error_log`)

## Notes

- Edge functions do not discover stations/timeseries. Discovery happens in the
  Python ingest script (see `scripts/uk_air_sos_ingest.py`).
- If `timeseries.station_id` is null, joins to stations will not work correctly.
  Run the discovery step to populate station links.
