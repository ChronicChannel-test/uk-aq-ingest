# GitHub Actions

This repo uses GitHub Actions for scheduled syncs and deployments.

## Workflows

### `supabase-keepalive.yml`
- Schedule: daily at 06:00 UTC.
- Purpose: run a lightweight keepalive query against Supabase.
- Script: `npm run keepalive`.
- Secrets: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_DEFAULT_KEY`, `KEEPALIVE_TABLE`, `KEEPALIVE_SELECT`.

### `supabase_edge_deploy.yml`
- Trigger: push to `main` affecting `supabase/functions/**`, or manual dispatch.
- Purpose: inject Supabase project ref into the web page, set Supabase secrets, deploy edge functions.
- Deployed functions: `ingest_uk_air_sos`, `ingest_breathelondon`, `ingest_sensorcommunity`,
  `uk_aq_latest`, `uk_aq_bristol_latest`, `uk_aq_la_hex`, `uk_aq_pcon_hex`,
  `uk_aq_stations`, `uk_aq_timeseries`.
- Secrets: `SUPABASE_PROJECT_REF`, `SUPABASE_PUBLISHABLE_DEFAULT_KEY`, `SB_ANON_JWT`,
  `SUPABASE_ACCESS_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SB_UK_AQ_CRON_SECRET`.

### `uk_aq_raw_dropbox.yml`
- Trigger: manual dispatch.
- Purpose: run a Bristol-only ingest with raw Dropbox upload for debugging/testing.
- Script: `python3 scripts/uk_air_sos/uk_air_sos_ingest.py --discover --refresh-recent ... --raw-dropbox`.
- Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DROPBOX_APP_KEY`,
  `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`.

### `uk_aq_breathelondon_batch.yml`
- Schedule: manual only (cron handles production batch polling).
- Purpose: batch station refs and invoke `ingest_breathelondon` per chunk for manual runs.
- Script: `python3 scripts/breathelondon/breathelondon_batch.py --connector-code breathelondon --batch-size 10 --active-only --skip-stations`.
- Order: oldest `breathelondon_timeseries_checkpoints.last_fetch_at` first (nulls first).
- Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SB_ANON_JWT`, `SB_UK_AQ_CRON_SECRET`.

### `uk_aq_stations_daily.yml`
- Schedule: daily at 03:00 UTC.
- Purpose: sync stations to Supabase (UK-AIR SOS + Breathe London) and export a combined stations snapshot to Dropbox.
- Script: `python3 scripts/uk_air_sos/uk_air_sos_list_stations.py --to-supabase`.
- Script: `python3 scripts/breathelondon/breathelondon_list_stations.py --to-supabase`.
- Script: `python3 scripts/uk_aq_refresh_station_geo_aiven.py` (refresh PCON/LA codes from Aiven).
- Export: `python3 scripts/uk_aq_export_stations_dropbox.py` (uploads `uk_aq_stations_<timestamp>.json`).
- Optional: Sensor.Community discovery step (disabled by default).
- Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `UK_AIR_SOS_BASE_URL`,
  `BREATHELONDON_API_KEY`, `BREATHELONDON_BASE_URL` (optional), `DROPBOX_APP_KEY`,
  `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`, `UK_AQ_DROPBOX_ROOT`, `UK_AQ_STATIONS_DROPBOX_DIR`,
  `PCON_AIVEN_PG_DSN`.
- Vars: `PCON_VERSION`, `LA_VERSION` (optional; defaults to latest in Aiven).

### `uk_aq_pcon_aiven_refresh.yml`
- Trigger: manual dispatch.
- Purpose: download PCON/LA GeoJSON from Dropbox and load boundaries into Aiven PostGIS.
- Scripts:
  - `python3 scripts/uk_aq_resolve_dropbox_geojson.py` (PCON + LA downloads).
  - `python3 scripts/uk_aq_load_pcon_boundaries_aiven.py`.
  - `python3 scripts/uk_aq_load_la_boundaries_aiven.py`.
- Secrets: `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`,
  `PCON_GEOJSON_DROPBOX_BASE` or `PCON_GEOJSON_DROPBOX_PATH`,
  `LA_GEOJSON_DROPBOX_BASE` or `LA_GEOJSON_DROPBOX_PATH`,
  `PCON_AIVEN_PG_DSN`, optional `PCON_CODE_FIELD`, `PCON_NAME_FIELD`,
  `LA_CODE_FIELD`, `LA_NAME_FIELD`, `PCON_BOUNDARY_BATCH_SIZE`,
  `LA_BOUNDARY_BATCH_SIZE`, `PCON_SLEEP_SECONDS`, `LA_SLEEP_SECONDS`,
  `PCON_MAX_RETRIES`, `LA_MAX_RETRIES`, `PCON_RETRY_BACKOFF_SECONDS`,
  `LA_RETRY_BACKOFF_SECONDS`.
- Vars: `PCON_VERSION`, `LA_VERSION` (optional; defaults to latest in Dropbox selection).

### `uk_aq_dispatcher_deploy.yml`
- Trigger: push to `main` affecting `workers/uk_aq_dispatcher/**`, or manual dispatch.
- Purpose: deploy the Cloudflare Worker cron dispatcher and set its secrets.
- Worker: `workers/uk_aq_dispatcher`.
- Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `SUPABASE_URL`, `SB_ANON_JWT`, `SB_UK_AQ_CRON_SECRET`.

### `uk_air_sos_site_register_monthly.yml`
- Schedule: monthly on day 1 at 04:15 UTC.
- Purpose: download the UK-AIR monitoring sites CSV via the search page.
- Script: `python3 scripts/uk_air_sos/uk_air_sos_site_register.py --output uk_air_sos_site_register.csv`.
- Output: uploads a timestamped CSV to Dropbox at `network_info/uk_air_sos` and loads it into Supabase.
- Secrets: `UK_AIR_SOS_SITE_SEARCH_URL`, `UK_AIR_SOS_SITE_SEARCH_USER_AGENT` (optional),
  `UK_AQ_DROPBOX_ROOT`, `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
