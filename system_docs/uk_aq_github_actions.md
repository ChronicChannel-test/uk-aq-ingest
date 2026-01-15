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
- Deployed functions: `ingest_uk_air_sos`, `ingest_sensorcommunity`, `uk_aq_latest`,
  `uk_aq_bristol_latest`, `uk_aq_la_hex`, `uk_aq_pcon_hex`, `uk_aq_stations`, `uk_aq_timeseries`.
- Secrets: `SUPABASE_PROJECT_REF`, `SUPABASE_PUBLISHABLE_DEFAULT_KEY`, `SUPABASE_ANON_JWT`,
  `SUPABASE_ACCESS_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

### `uk_aq_raw_dropbox.yml`
- Trigger: manual dispatch.
- Purpose: run a Bristol-only ingest with raw Dropbox upload for debugging/testing.
- Script: `python3 scripts/uk_air_sos_ingest.py --discover --refresh-recent ... --raw-dropbox`.
- Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DROPBOX_APP_KEY`,
  `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`.

### `uk_aq_stations_daily.yml`
- Schedule: daily at 03:00 UTC.
- Purpose: sync stations to Supabase and update `uk_air_sos_stations.json`.
- Script: `python3 scripts/uk_air_sos_list_stations.py --to-supabase`.
- Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `UK_AIR_SOS_BASE_URL`.
