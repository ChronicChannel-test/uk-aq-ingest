# UK-AQ Scripts

This document summarizes the UK-AQ helper scripts and their inputs/outputs.

## Environment

**Supabase**
- `SUPABASE_URL`
- `SB_SECRET_KEY`

**UK-AIR SOS**
- `UK_AIR_SOS_BASE_URL` (optional; defaults to `https://uk-air.defra.gov.uk/sos-ukair/api/v1`)
  - The scripts also accept the legacy `UK_AIR_BASE_URL` or `UKAIR_BASE_URL` if set.
- `UK_AIR_SOS_SERVICE_LABEL` (optional; defaults to `UK-AIR-SOS`)

**Sensor.Community**
- `SCOMM_BASE_URL` (optional; defaults to `https://data.sensor.community`)
- `SCOMM_CONNECTOR_CODE` (optional; defaults to `sensorcommunity`; legacy `SCOMM_CONNECTOR_REF` supported)
- `SCOMM_SERVICE_REF` (optional; defaults to `SCOMM_CONNECTOR_CODE`)

**OpenAQ**
- `SCOMM_SERVICE_LABEL` (optional; defaults to `Sensor.Community`; legacy `SCOMM_CONNECTOR_LABEL` supported)
- `SCOMM_COUNTRY` (optional; defaults to `GB`)
- `SCOMM_USER_AGENT` (optional; identifies your client when polling Sensor.Community)
- `SCOMM_INGEST_MET_FIELDS` (optional; defaults to `false`; enable temperature/humidity/pressure ingestion)
- `SCOMM_LOG_LEVEL` (optional; defaults to `INFO`)
- `OPENAQ_BASE_URL` (optional; defaults to `https://api.openaq.org/v3`)
- `OPENAQ_API_KEY` (required; OpenAQ API key)
- `OPENAQ_CONNECTOR_CODE` (optional; defaults to `openaq`)
- `OPENAQ_SERVICE_REF` (optional; defaults to `OPENAQ_CONNECTOR_CODE`)
- `OPENAQ_SERVICE_LABEL` (optional; defaults to `OpenAQ`)
- `OPENAQ_USER_AGENT` (optional; defaults to `uk-air-quality-networks`)
- `OPENAQ_BBOX` (optional; defaults to `-8.623555,49.863222,1.763337,60.871222`)
- `OPENAQ_PAGE_LIMIT` (optional; defaults to `1000`)
- `OPENAQ_MAX_PAGES` (optional; defaults to `0` meaning no cap)
- `OPENAQ_LOG_LEVEL` (optional; defaults to `INFO`)

## Scripts

### `scripts/uk_aq_supabase.py`
Purpose:
- Central helper for Supabase clients that target `uk_aq_core`, `uk_aq_raw`, and `uk_aq_pop`.
- Provides `create_supabase_client` plus `SupabaseSchemas` / `SchemaClient` wrappers for schema-specific `.table()` and `.rpc()` calls.

Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY` (or `SUPABASE_KEY` fallback)
- `UK_AQ_CORE_SCHEMA` (optional; defaults to `uk_aq_core`)
- `UK_AQ_RAW_SCHEMA` (optional; defaults to `uk_aq_raw`)
- `UK_AQ_POP_SCHEMA` (optional; defaults to `uk_aq_pop`)

### `scripts/uk_aq_inject_project_ref.mjs`
Purpose:
- Replace Supabase placeholders in web assets during GitHub Actions deploys.

Placeholders:
- `__SUPABASE_PROJECT_REF__` or `{{SUPABASE_PROJECT_REF}}`
- `__SB_PUBLISHABLE_DEFAULT_KEY__` or `{{SB_PUBLISHABLE_DEFAULT_KEY}}`

Notes:
- If no placeholders are found, the script exits without changes.
- Optional: `UK_AQ_INJECT_PATHS` (comma-separated file paths) to limit which files are scanned.

Environment:
- `SUPABASE_PROJECT_REF`
- `SB_PUBLISHABLE_DEFAULT_KEY`

### `scripts/uk_aq_check_env.sh`
Purpose:
- Run one-pass validation for local Supabase env variables used by Ingest + History.
- Check variable presence, project-ref alignment, masked secret previews, JWT-formatted key claims, and optional live HTTP checks.

Common commands:
```
./scripts/uk_aq_check_env.sh
./scripts/uk_aq_check_env.sh --no-network
./scripts/uk_aq_check_env.sh --env-file .env.supabase
```

Notes:
- Exit code `0` = pass (warnings allowed); exit code `1` = one or more failures.
- Network mode validates:
  - `SUPABASE_ACCESS_TOKEN` against Supabase Management API.
  - Main/history REST root access with `SB_PUBLISHABLE_DEFAULT_KEY`, main privileged key (`SB_SECRET_KEY` preferred), and `OBS_AQIDB_SECRET_KEY`.
- Secret values are masked in output.

### `scripts/uk_aq_sync_github_secrets.sh`
Purpose:
- Sync local env files to GitHub Actions secrets/variables.
- Route each key using `config/uk_aq_github_env_targets.csv` (`secret`, `variable`, `both`, or `local`).
- Upload non-local keys from `.env.supabase` into the `SUPABASE_SECRETS_ENV` GitHub secret for edge deploy.

Common commands:
```bash
scripts/uk_aq_sync_github_secrets.sh --dry-run
scripts/uk_aq_sync_github_secrets.sh --repo owner/repo
scripts/uk_aq_sync_github_secrets.sh --targets-file config/uk_aq_github_env_targets.csv
```

Notes:
- Unmapped keys default to `local` (not synced to GitHub).
- `GCP_SA_KEY` uploads file contents when the value points to a local path.
- `SUPABASE_DB_URL` is normalized to avoid accidental double-encoding before sync.
- `--dry-run` prints key names and value lengths (not raw values).
- `SUPABASE_SECRETS_ENV` includes only non-local keys from the Supabase env file.
- Any `SUPABASE_SECRETS_ENV=...` line in env files is ignored; the value is always rebuilt by the script.
- Keep `config/uk_aq_github_env_targets.csv` aligned with workflow `vars.*` / `secrets.*` references.

### `scripts/uk_aq_run_ingestdb_prune.sh`
Purpose:
- Invoke `uk-aq-ingestdb-prune-service` with window controls (`retentionDays`, `maxHours`).
- Support local user-friendly auth via `gcloud run services proxy` (default).
- Optionally call with service-account identity tokens via impersonation.

Common commands:
```bash
scripts/uk_aq_run_ingestdb_prune.sh --dry-run --start-date 2026-02-10 --max-hours 48
scripts/uk_aq_run_ingestdb_prune.sh --dry-run --retention-days 9 --max-hours 48
scripts/uk_aq_run_ingestdb_prune.sh --live --window-start 2026-02-10 --window-end 2026-02-12
scripts/uk_aq_run_ingestdb_prune.sh --auth-mode impersonate \
  --impersonate-service-account uk-aq-ops-job@astute-lyceum-484111-k5.iam.gserviceaccount.com
```

Notes:
- Defaults:
  - `--project`: `GCP_PROJECT_ID` or `astute-lyceum-484111-k5`
  - `--region`: `GCP_REGION` or `europe-west2`
  - `--service`: `uk-aq-ingestdb-prune-service`
  - `--auth-mode`: `proxy`
- `--proxy-timeout-seconds` controls proxy readiness wait (default `60`).
- `--window-start/--window-end` computes `retentionDays` + `maxHours` automatically (UTC), with `window-end` treated as inclusive.
- `--start-date` + `--max-hours` computes `retentionDays` automatically.
- With current prune API, start-date mode requires `start-date + max-hours` to land on `00:00 UTC` (for example 24/48/72 hours).
- `proxy` mode avoids the common user-account `print-identity-token --audiences` error.

### `scripts/uk_aq_int4_migration_all_clear.sh`
Purpose:
- Run post-migration all-clear checks for the connector/timeseries ID `int4` migration on MAIN and HISTORY DBs.
- Validate target column types, FK type parity, key RPC signatures, and basic smoke queries.

Common commands:
```bash
scripts/uk_aq_int4_migration_all_clear.sh
scripts/uk_aq_int4_migration_all_clear.sh --main-only
scripts/uk_aq_int4_migration_all_clear.sh --history-only --history-db-url "$OBS_AQIDB_SUPABASE_DB_URL"
scripts/uk_aq_int4_migration_all_clear.sh --env-file .env
```

Notes:
- The script defaults to `.env` in the ingest repo and auto-loads DB URLs from env if flags are not passed.
- It sets `PGOPTIONS` to disable statement/lock/idle transaction timeouts when not already set.
- `--main-only` and `--history-only` allow targeted validation runs.

Environment:
- MAIN DB URL: `SUPABASE_DB_URL` (or `--main-db-url`)
- HISTORY DB URL: `OBS_AQIDB_SUPABASE_DB_URL` or `SBASE_HISTORY_DB_URL` (or `--history-db-url`)

### `scripts/gcp/uk_aq_secret_upsert_if_changed.sh`
Purpose:
- Upsert one GCP Secret Manager secret from stdin.
- Add a new secret version only when the value hash changed.
- Store a content-hash label on the secret to support safe no-plaintext comparisons.

Common commands:
```bash
printf '%s' "$SB_SECRET_KEY" | \
  scripts/gcp/uk_aq_secret_upsert_if_changed.sh \
    --project "$GCP_PROJECT_ID" \
    --secret "SB_SECRET_KEY" \
    --required 1

printf '%s' "$OPENAQ_API_KEY" | \
  scripts/gcp/uk_aq_secret_upsert_if_changed.sh \
    --project "$GCP_PROJECT_ID" \
    --secret "OPENAQ_API_KEY" \
    --required 1 \
    --dry-run
```

Notes:
- Does not fetch secret plaintext from Secret Manager.
- `--dry-run` prints planned create/update/skip actions.

### `scripts/gcp/uk_aq_secret_manager_prune_versions.sh`
Purpose:
- Reduce Secret Manager version storage by destroying older versions per secret.
- Keep the newest `N` versions (`N=1` for current cost-control policy).

Common commands:
```bash
scripts/gcp/uk_aq_secret_manager_prune_versions.sh \
  --project "$GCP_PROJECT_ID" \
  --keep 1 \
  --dry-run

scripts/gcp/uk_aq_secret_manager_prune_versions.sh \
  --project "$GCP_PROJECT_ID" \
  --keep 1
```

Notes:
- Works across all secrets by default, or one secret via repeated `--secret`.
- `--dry-run` prints planned destroys without changing versions.

### `scripts/gcp_billing_export_check.sh`
Purpose:
- Check whether Cloud Billing export to BigQuery is enabled and producing billing export tables.
- Confirm whether export table schema includes a `labels` field for label-based cost analysis.

Common commands:
```bash
BILLING_EXPORT_PROJECT=my-billing-proj BILLING_EXPORT_DATASET=billing_export \
  ./scripts/gcp_billing_export_check.sh

./scripts/gcp_billing_export_check.sh --project my-billing-proj --dataset billing_export
```

Notes:
- Reports `PASS` only when billing export tables are present.
- If a dataset exists but no export tables are present yet, reports `FAIL` with a startup-delay warning.
- Console path to enable export: `Billing -> Billing export -> BigQuery export`.

### `scripts/uk_aq_export_connectors_snapshot.py`
Purpose:
- Export connector polling settings and station/timeseries counts to a CSV for spreadsheet review.

Common commands:
```
python3 scripts/uk_aq_export_connectors_snapshot.py
python3 scripts/uk_aq_export_connectors_snapshot.py --output network_info/uk_aq/uk_aq_connectors_snapshot.csv
```

Notes:
- Output includes `hours_since_*` fields derived from connector `last_polled_at` / `last_run_end` and timeseries `last_value_at`.

Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY`

### `scripts/uk_aq_dashboard_local.py`
Purpose:
- Run a local dashboard server that exposes PM2.5, PM10, and NO2 freshness buckets (timeseries last_value_at).

Common commands:
```
python3 scripts/uk_aq_dashboard_local.py --port 8045
```

Notes:
- Serves the UI at `http://127.0.0.1:8045` and JSON at `/api/dashboard`.
- The HTML lives at `data/uk_aq_dashboard/uk_aq_dashboard.html`.
- Storage coverage calendar includes a `Force Refresh` button (left of `Previous`) that calls `/api/dashboard?force=1` to bypass server cache and rebuild calendar rows immediately.
- Storage coverage uses per-day presence for aggdaily (`uk_aq_public.uk_aq_station_aqi_daily`), keeps ingest/history on `oldest_observed_at` range logic, makes top-row ingest/R2 mutually exclusive (R2 takes precedence), and refreshes automatically at 05:00 UTC daily (or immediately via `Force Refresh`).
- Dispatcher feed shows gap-station context for OpenAQ runs as `(<n> GAP)` under Stations when `gap_stations_polled > 0`.
- Includes a DB cluster size panel with period selector (`6h`, `12h`, `24h`, `48h`, `7d`, `14d`, `28d`): line chart for `ingestdb` + `obs_aqidb` cluster MB (dynamic Y max), schema stacked area chart for `uk_aq_observs` + `uk_aq_aqilevels` MB, and R2 History domain stacked area chart for `observations` + `aqilevels` MB; missing series values render as `0`, and the schema oldest-day legend row is `uk_aq_observs >= DD/MM/YYYY   uk_aq_aqilevels >= DD/MM/YYYY`.
- Requires a service role key (anon/authenticated JWTs will be rejected).

Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `UK_AQ_PUBLIC_SCHEMA` (optional; default `uk_aq_public`, used for DB size metrics view reads)
- `UK_AQ_DB_SIZE_LOOKBACK_DAYS` (optional; default `28`)
- `UK_AQ_DB_SIZE_API_URL` (optional; Cloudflare/API endpoint for DB size metrics fan-in)
- `UK_AQ_DB_SIZE_API_TOKEN` (optional; bearer token for `UK_AQ_DB_SIZE_API_URL`)
- `OBS_AQIDB_SUPABASE_URL` / `OBS_AQIDB_SECRET_KEY` (optional direct fallback for `obs_aqidb` DB-size series when `UK_AQ_DB_SIZE_API_URL` is not set/unavailable)
- `UK_AQ_R2_BACKUP_WINDOW_RPC` (optional; default `uk_aq_rpc_r2_backup_window`)
- `UK_AQ_COVERAGE_DAY_FETCH_LIMIT` (optional; default `1000`, page size for per-day coverage fetches)
- `UK_AQ_AGGDAILY_COVERAGE_DAYS_VIEW` (optional; default `uk_aq_station_aqi_daily`)

### `scripts/stations_daily/sync_aggdaily_uk_aq_core.py`
Purpose:
- Mirror `uk_aq_core` reference tables from ingest DB into Agg Daily DB as an exact PK set match.
- Sync scope is limited to:
  - `uk_aq_core.connectors`
  - `uk_aq_core.phenomena`
  - `uk_aq_core.stations`
  - `uk_aq_core.timeseries`

Behavior:
- Reads source rows from ingest via PostgREST (`Accept-Profile`/`Content-Profile: uk_aq_core`).
- Upserts destination rows by table primary key (`resolution=merge-duplicates` + `on_conflict=<pk>`).
- Hard-deletes destination rows whose PKs no longer exist in ingest.
- Also syncs FK dependency tables (`observed_properties`, `categories`, `offerings`, `features`, `procedures`) in dependency-safe order so mirrored rows can insert/delete cleanly.
- Validates destination schema against source metadata (column order/name/type/nullability/default + PK) before any write.
- Fails fast (non-zero exit) on schema mismatch or sync errors.

Environment:
- `SRC_SUPABASE_URL`
- `SRC_SECRET_KEY`
- `DST_SUPABASE_URL`
- `DST_SECRET_KEY`
- `UK_AQ_INGEST_CORE_SCHEMA_SQL_PATH` (optional local fallback path for source DDL parsing)

Notes:
- Destination metadata is read via `uk_aq_public.uk_aq_rpc_info_schema_columns` and `uk_aq_public.uk_aq_rpc_info_schema_primary_keys`.
- Apply agg_daily schema SQL first on Agg Daily DB:
  - `CIC-test-uk-aq-schema/schemas/aggdaily_db/uk_aq_aggdaily_schema.sql`

### `scripts/uk_aq_station_snapshot_local.py`
Purpose:
- Run a separate local dashboard for station-level raw snapshot inspection via the protected edge function `uk_aq_station_snapshot`.

Common commands:
```
python3 scripts/uk_aq_station_snapshot_local.py --port 8046
python3 scripts/uk_aq_station_snapshot_local.py --edge-url https://<project>.supabase.co/functions/v1/uk_aq_station_snapshot
```

Notes:
- Serves the UI at `http://127.0.0.1:8046` and config at `/api/config`.
- The HTML lives at `data/uk_aq_station_snapshot/uk_aq_station_snapshot.html`.
- Access token comes from `UK_AQ_DEV_JWT` (or `--dev-jwt`) and is injected via `/api/config` (no JWT input field in UI).
- If `UK_AQ_DEV_REFRESH_TOKEN` is set, the local server can auto-refresh expired access tokens via `/api/token`.
- Rotated refresh tokens are written back to the env file (default: `.env.supabase`) so restarts keep working.
- The page renders raw rows for `stations`, `timeseries`, `openaq_station_checkpoints`, `openaq_timeseries_checkpoints`, and `observations`.

Environment:
- `SUPABASE_URL` or `SB_SUPABASE_URL` (used to derive edge URL if not passed)
- `UK_AQ_STATION_SNAPSHOT_EDGE_URL` (optional explicit edge URL)
- `UK_AQ_DEV_JWT` (required unless `UK_AQ_DEV_REFRESH_TOKEN` is provided)
- `UK_AQ_DEV_REFRESH_TOKEN` (optional; enables auto-refresh)
- `UK_AQ_DEV_ENV_FILE` (optional; env file to persist rotated refresh tokens, default `.env.supabase`)
- `SB_PUBLISHABLE_DEFAULT_KEY` required when using auto-refresh

### `scripts/uk_aq_issue_dev_auth_tokens.py`
Purpose:
- Issue fresh Supabase auth tokens for local dashboard use and optionally write them into an env file.

Common commands:
```
python3 scripts/uk_aq_issue_dev_auth_tokens.py
python3 scripts/uk_aq_issue_dev_auth_tokens.py --write-env-file .env.supabase
python3 scripts/uk_aq_issue_dev_auth_tokens.py --refresh-token "$UK_AQ_DEV_REFRESH_TOKEN"
```

Notes:
- Uses password grant when `--email/--password` (or `UK_AQ_DEV_USER_EMAIL` / `UK_AQ_DEV_USER_PASSWORD`) are provided.
- Uses refresh-token grant when `--refresh-token` (or `UK_AQ_DEV_REFRESH_TOKEN`) is provided.
- Outputs `UK_AQ_DEV_JWT`, `UK_AQ_DEV_REFRESH_TOKEN`, and `UK_AQ_DEV_JWT_EXPIRES_AT` for export by default.

Environment:
- `SUPABASE_URL` or `SB_SUPABASE_URL`
- `SB_PUBLISHABLE_DEFAULT_KEY`
- `UK_AQ_DEV_USER_EMAIL` + `UK_AQ_DEV_USER_PASSWORD` (for password grant), or `UK_AQ_DEV_REFRESH_TOKEN` (for refresh grant)

### `dev_dashboards.sh` and `dev_dashboards_stop.sh`
Purpose:
- Start/stop both local dashboard servers on-demand:
  - `scripts/uk_aq_dashboard_local.py`
  - `scripts/uk_aq_station_snapshot_local.py`

Common commands:
```
./dev_dashboards.sh
./dev_dashboards_stop.sh
```

Notes:
- `dev_dashboards.sh` writes `./.dashboards.pids` and logs to `./logs/`.
- `dev_dashboards_stop.sh` only stops exact PIDs listed in `./.dashboards.pids` (no broad `pkill`).

Environment:
- Required: `SUPABASE_URL`, `SB_PUBLISHABLE_DEFAULT_KEY`, and either `UK_AQ_DEV_JWT` or `UK_AQ_DEV_REFRESH_TOKEN`
- Optional overrides: `HOST`, `SCHEDULER_PORT`, `SNAPSHOT_PORT`

### `scripts/uk_air_sos/uk_air_sos_ingest.py`
Purpose:
- Discover stations and timeseries with optional filters.
- Backfill observations for a chosen year.
- Refresh recent observations for the last N hours.

Common commands:
```
python3 scripts/uk_air_sos/uk_air_sos_ingest.py --discover --backfill-2025
python3 scripts/uk_air_sos/uk_air_sos_ingest.py --refresh-recent --hours 6
```

Writes to:
- `connectors`, `stations`, `timeseries`, `observations`

Key flags:
- `--bbox west,south,east,north` (default: UK bbox)
- `--region Bristol` (optional)
- `--station-like Bristol` (optional label filter)
- `--station-type AURN` (optional)
- `--strict-bbox` to exclude stations with missing coordinates
- `--pollutants no2,o3,pm10,pm2.5` (default common pollutants)
- `--all-pollutants` to disable pollutant filtering
- `--backfill-year 2025` to backfill a specific year
- `--service-ref` (alias `--service-id`) or `--service-label` to target a specific SOS service
- `--sample-timeseries 1` to log a short summary of the first N timeseries objects
- `--raw-dropbox` to write raw payloads to Dropbox (testing only; guarded by `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`)
- `--raw-dropbox-folder /connectors/uk_air_sos/raw_data` to override the Dropbox folder
- `--log-level WARNING` to reduce logging output
    - Default output prints only station count, error count, and Dropbox upload info.
Batching:
- If `connectors.poll_timeseries_batch_size` is set for the chosen connector, it overrides the default batch size for timeseries discovery.
Stations bbox:
- If `connectors.stations_bbox_supported` is false, the script skips bbox when calling `/stations`.
Timeseries station filter:
- If `connectors.timeseries_station_filter_supported` is false, the script skips station filtering for `/timeseries`.
Phenomenon lookup:
- If a timeseries label contains a `dd.eionet.europa.eu/vocabulary/aq/pollutant/` URL and `phenomenon` is missing, the script resolves Eionet metadata and stores `phenomena.source_label` + `phenomena.notation` (shortname), with `label` falling back to `prefLabel`.

Raw payloads (testing only):
- Raw payload uploads are disabled unless `SUPABASE_URL` matches `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`.
- Dropbox credentials required: `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`.
- The raw capture writes all SOS responses fetched during the run into a single gzipped JSONL file and uploads it to Dropbox.
- Uploads are organized under `connectors/uk_air_sos/raw_data/YYYY-MM-DD` within the configured Dropbox folder (for scoped apps, do not include `/Apps/<app>` in the path).
- Each run also uploads a log file to `/connectors/uk_air_sos/log/YYYY-MM-DD/` (Dropbox app root).
- Logs older than 31 days are zipped into `/connectors/uk_air_sos/log/archive/YYYY-MM-DD.zip`; archive files older than 1 year are removed.
- If `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL` is unset in live environments, the upload never runs (even if `--raw-dropbox` is passed).

### `scripts/erg_laqn/erg_laqn_list_stations.py`
Purpose:
- Fetch LAQN monitoring sites from the ERG AirQuality API.
- Optionally upsert LAQN stations, station_metadata, and seed timeseries rows into Supabase.

Common commands:
```
python3 scripts/erg_laqn/erg_laqn_list_stations.py
python3 scripts/erg_laqn/erg_laqn_list_stations.py --format csv --output laqn_stations.csv
python3 scripts/erg_laqn/erg_laqn_list_stations.py --to-supabase
```

Key flags:
- `--group` to override the GroupName filter (default: London).
- `--no-filter` to skip UK bounding box filtering.
- `--skip-station-metadata` to avoid station_metadata updates.
- `--skip-timeseries` to avoid seeding timeseries rows for each station/species.

Notes:
- Connector upserts preserve existing `poll_enabled`; new connectors default to `poll_enabled=false`.


Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `LAQN_BASE_URL` (optional; defaults to `https://api.erg.ic.ac.uk/AirQuality`)
- `LAQN_DEFAULT_GROUP` (optional; defaults to `London`)
- `LAQN_MONITORING_SITES_PATHS` (optional; comma-separated API paths to try)
- `LAQN_CONNECTOR_CODE` (optional; defaults to `erg_laqn`)
- `LAQN_CONNECTOR_LABEL` (optional; defaults to `ERG London Air`, falls back to `LAQN_SERVICE_LABEL`)
- `LAQN_CONNECTOR_DISPLAY_NAME` (optional; defaults to `London Air LAQN`)
- `LAQN_SERVICE_REF` (optional; defaults to `LAQN_CONNECTOR_CODE`)
- `LAQN_USER_AGENT` (optional)
- `LAQN_TIMESERIES_SPECIES` (optional; defaults to `NO2,PM10,PM25,O3`)

### `scripts/openaq/openaq_list_stations.py`
Purpose:
- Fetch OpenAQ locations within the UK bounding box and optionally upsert stations into Supabase.

Common commands:
```
python3 scripts/openaq/openaq_list_stations.py
python3 scripts/openaq/openaq_list_stations.py --format csv --output uk_openaq_stations.csv
python3 scripts/openaq/openaq_list_stations.py --to-supabase
```

Notes:
- Connector upserts preserve existing `poll_enabled`; new connectors default to `poll_enabled=false`.

Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `SUPABASE_DB_URL` (required when using `--to-supabase`)
- `OPENAQ_BASE_URL` (optional; defaults to `https://api.openaq.org/v3`)
- `OPENAQ_API_KEY` (required)
- `OPENAQ_CONNECTOR_CODE` (optional; defaults to `openaq`)
- `OPENAQ_SERVICE_REF` (optional; defaults to `OPENAQ_CONNECTOR_CODE`)
- `OPENAQ_SERVICE_LABEL` (optional; defaults to `OpenAQ`)
- `OPENAQ_USER_AGENT` (optional; defaults to `uk-air-quality-networks`)
- `OPENAQ_BBOX` (optional; defaults to `-8.623555,49.863222,1.763337,60.871222`)
- `OPENAQ_PAGE_LIMIT` (optional; defaults to `1000`)
- `OPENAQ_MAX_PAGES` (optional; defaults to `0` meaning no cap)
- `OPENAQ_RATE_LIMIT_PER_MIN` (optional; defaults to `60`)
- `OPENAQ_LOG_LEVEL` (optional; defaults to `INFO`)

### `scripts/erg_laqn/erg_laqn_ingest.py`
Purpose:
- Ingest LAQN observations from the ERG AirQuality API into Supabase.

Common commands:
```
python3 scripts/erg_laqn/erg_laqn_ingest.py --species NO2,PM10
python3 scripts/erg_laqn/erg_laqn_ingest.py --days 3 --limit 5 --dry-run
```

Key flags:
- `--species` to set pollutant species codes (default: NO2,PM10,PM25,O3).
- `--days` or `--start-date`/`--end-date` to control the ingest window.
- `--index-days` is not supported by LAQN raw data endpoints; the script logs a warning and uses the date range.
- `--site-codes` to ingest a subset of station refs.
- `--stations-json` to use a local LAQN stations snapshot instead of the live API.
- `--skip-stations` to avoid station upserts.
- `--dry-run` to skip Supabase writes while still fetching observations (outputs use a `timeseries_id` of `0`).
- `--output-raw-responses` to write raw API responses per station/species.

Notes:
- Skips zero-valued observations from the most recent hour so placeholder zeros are not written to the DB.

Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `LAQN_BASE_URL` (optional; defaults to `https://api.erg.ic.ac.uk/AirQuality`)
- `LAQN_RAW_DATA_URL_TEMPLATE` (optional; overrides the raw data endpoint URL template)
- `LAQN_CONNECTOR_CODE` (optional; defaults to `erg_laqn`)
- `LAQN_CONNECTOR_LABEL` (optional; defaults to `ERG London Air`, falls back to `LAQN_SERVICE_LABEL`)
- `LAQN_CONNECTOR_DISPLAY_NAME` (optional; defaults to `London Air LAQN`)
- `LAQN_SERVICE_REF` (optional; defaults to `LAQN_CONNECTOR_CODE`)
- `LAQN_USER_AGENT` (optional)

### `scripts/erg_laqn/erg_laqn_latest_check.py`
Purpose:
- Check the latest available LAQN observations for a sample of active sites/species.

Common commands:
```
python3 scripts/erg_laqn/erg_laqn_latest_check.py --days 2 --species NO2,PM10
```

Key flags:
- `--days` lookback window in days (default: 2).
- `--species` comma-separated species list (default: NO2).
- `--max-sites` number of active sites to test (default: 5).
- `--stations-json` path to a stations JSON snapshot (default: `erg_laqn_stations.json`).
- `--base-url` ERG API base URL.
- `--timeout` HTTP timeout in seconds.

Environment:
- `LAQN_BASE_URL` (optional; defaults to `https://api.erg.ic.ac.uk/AirQuality`)
- `LAQN_STATIONS_JSON` (optional; defaults to `erg_laqn_stations.json`)

### `scripts/uk_aq_move_history_observations.sh`
Purpose:
- Move observations older than a cutoff from the main DB into the history DB in batches.

Common commands:
```
CUTOFF_DAYS=14 BATCH_SIZE=50000 ./scripts/uk_aq_move_history_observations.sh
./scripts/uk_aq_move_history_observations.sh --days 21 --batch-size 20000
```

Key flags:
- `--days` cutoff age in days (default: 14).
- `--batch-size` rows per batch (default: 50,000).

Environment:
- `SUPABASE_DB_URL` (main DB)
- `SBASE_HISTORY_DB_URL` (history DB)
- `CUTOFF_DAYS` (optional; default 14)
- `BATCH_SIZE` (optional; default 50,000)

### `scripts/uk_aq_refresh_station_geo_aiven.py`
Purpose:
- Look up PCON + LA codes in an Aiven PostGIS DB and update missing values in `stations`.

Common commands:
```
python3 scripts/uk_aq_refresh_station_geo_aiven.py
python3 scripts/uk_aq_refresh_station_geo_aiven.py --page-size 200 --dry-run
```

Key flags:
- `--page-size` Supabase page size (default: 500).
- `--limit` max stations to process (default: 0 = no limit).
- `--sleep-seconds` sleep between updates (default: 0).
- `--dry-run` log updates without writing.

Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `PCON_AIVEN_PG_DSN`
- `PCON_VERSION` (optional; defaults to latest in Aiven)
- `LA_VERSION` (optional; defaults to latest in Aiven)

### `scripts/uk_aq_resolve_dropbox_geojson.py`
Purpose:
- Resolve and download a GeoJSON file from Dropbox, selecting the latest version when needed.

Common commands:
```
python3 scripts/uk_aq_resolve_dropbox_geojson.py --dropbox-base "/GeoJSON/PCON" --output tmp/pcon.geojson --env-prefix PCON
```

Key flags:
- `--dropbox-base` folder path to search (optional if `--dropbox-path` is provided).
- `--dropbox-path` direct path to a GeoJSON file.
- `--version` target year/version (optional).
- `--output` local output path (required).
- `--env-prefix` prefix for writing `*_VERSION` + `*_GEOJSON_PATH` into `GITHUB_ENV`.

Environment:
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

### `scripts/uk_aq_load_pcon_boundaries_aiven.py`
Purpose:
- Load PCON GeoJSON boundaries into Aiven PostGIS.

Common commands:
```
python3 scripts/uk_aq_load_pcon_boundaries_aiven.py --geojson tmp/pcon.geojson --pcon-version 2024
```

Key flags:
- `--code-field` GeoJSON property for PCON code (default: `PCON24CD`).
- `--name-field` GeoJSON property for PCON name (default: `PCON24NM`).
- `--skip-if-exists` skip upload if version already exists.

Environment:
- `PCON_AIVEN_PG_DSN`

Note:
- Legacy Supabase boundary loaders moved to `archive/2026-01-25/scripts/`.

### `scripts/uk_aq_load_la_boundaries_aiven.py`
Purpose:
- Load LA GeoJSON boundaries into Aiven PostGIS.

Common commands:
```
python3 scripts/uk_aq_load_la_boundaries_aiven.py --geojson tmp/la.geojson --la-version 2024
```

Key flags:
- `--code-field` GeoJSON property for LA code (default: `la_code`).
- `--name-field` GeoJSON property for LA name (default: `la_name`).
- `--source-srid` SRID of the GeoJSON coordinates (default: 4326; LAD 2025 BGC uses 27700).
- `--skip-if-exists` skip upload if version already exists.

Environment:
- `PCON_AIVEN_PG_DSN`

### `scripts/uk_aq_load_guidelines.py`
Purpose:
- Load WHO GAQG 2021 guideline limits into `uk_aq_guidelines`.

Common commands:
```
python3 scripts/uk_aq_load_guidelines.py
python3 scripts/uk_aq_load_guidelines.py --csv data/WHO-guidelines/WHO_GAQG_2021_pollutant_limits.csv
```

Inputs:
- CSV with columns: pollutant, averaging_time, unit, AQG_2021, IT1, IT2, IT3, IT4, notes, source.

Key flags:
- `--source` to override the CSV source column value for all rows.
- `--batch-size` (default: 200)

Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY`

### `scripts/uk_aq_fix_station_geometry.py`
Purpose:
- Fix swapped station geometry coordinates (lat/lon reversed).

Common commands:
```
python3 scripts/uk_aq_fix_station_geometry.py
```

Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY`

### `scripts/uk_aq_enrich_station_names.py`
Purpose:
- Preview OSNI Gazetteer place-name matches for stations missing `station_name`.
 - Optionally backfill `stations.region` using OS Open Names GB lookups.

Common commands:
```
python3 scripts/uk_aq_enrich_station_names.py --matches 5
```

Inputs:
- GeoJSON point files:
  - Placenames (default: `data/geojson/OSNI/osni_open_data_-_gazetteer_-_place_names.geojson`).
  - Streetnames (default: `data/geojson/OSNI/osni_open_data_-_gazetteer_-_streetnames.geojson`).
- Optional GB GPKG: `data/gpkg/OS/os_open_names_gpkg/Data/opname_gb.gpkg` (downloaded from Dropbox if missing and a Dropbox path is provided).
  - If the GPKG CRS is not EPSG:4326, install `pyproj` so the script can project station coordinates.

Key flags:
- `--limit` number of stations to inspect (0 means no limit).
- `--matches` number of nearby names to list per station.
- `--max-distance-m` optional maximum distance in meters.
- `--streetnames-geojson` override streetnames GeoJSON path.
- `--no-ni-filter` to also attempt OSNI matching for non-NI stations (debugging only).
- `--apply` update `stations.station_name` for rows with proposed names.
- `--apply` also updates `stations.region` when a GB match provides a region and the station is missing one.
- `--apply-batch-size` batch size for station_name updates (default: 200).
- In `--apply` mode, the script skips automatic summary lookups for pollutants/latest observations unless `--include-pollutants` or `--include-latest` is passed explicitly.

### `scripts/uk_aq_backfill_station_regions.py`
Purpose:
- Backfill `stations.region` using OS Open Names GB lookups for stations missing a region.

Common commands:
```
python3 scripts/uk_aq_backfill_station_regions.py
python3 scripts/uk_aq_backfill_station_regions.py --apply
```

Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY`
- Optional Dropbox credentials if `--download-gb-gpkg` is used.

### `scripts/uk_aq_enrich_test_script.py`
Purpose:
- Debug the Supabase REST counts used to decide whether enrichment runs.

Common commands:
```
python3 scripts/uk_aq_enrich_test_script.py
python3 scripts/uk_aq_enrich_test_script.py --samples 10 --verbose
```

Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `--page-size` Supabase pagination batch size.
- `--gb-gpkg-path` local path for the OS Open Names GB GeoPackage.
- `--gb-gpkg-dropbox-path` Dropbox path for the GB GPKG (defaults to `UK_AQ_OS_OPEN_NAMES_GB_DROPBOX_PATH` or the local path).
- `--download-gb-gpkg` download the GB GPKG from Dropbox if missing (also auto-downloads when a Dropbox path is set).
- `--include-gb`/`--no-include-gb` include GB stations using OS Open Names lookups (default: on).
- `--gb-search-radius-m` search radius for OS Open Names in meters (default: 5000).
  - GB matches are split into place/street/other based on `local_type`.
  - Place matches also use `populated_place` (fallback to district/borough).
  - GB lookups now scan all candidates within the search radius to find the nearest street.
  - When no GB street matches are found, the closest `gb_other_matches` entry is used for the proposed name.
  - Postcode fallbacks keep their original casing.
- `--include-pollutants` to include pollutant names per station (timeseries/phenomena lookup).
- `--include-latest` to include latest observations per station by phenomenon.
- `--output-format` set to `summary` (default, JSON lines) or `json` (full payload).
  - NI matches use `ni_place_matches`/`ni_street_matches` to avoid confusion with GB matches.

Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `UK_AQ_OS_OPEN_NAMES_GB_DROPBOX_PATH` (optional Dropbox path for the GB GPKG).
- `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` (needed if a Dropbox download is triggered).
- `PYPROJ_NETWORK` (optional; set to `ON` if pyproj needs to download grid data).

### `scripts/uk_aq_enrich_station_names_report.py`
Purpose:
- Write station name enrichment results to JSON files for review.

Outputs:
- `station_names_proposed_YYYYMMDD_HHMMSS.json` (summary for every station with `station_name` null).
- `station_names_missing_YYYYMMDD_HHMMSS.json` (detailed payloads where `proposed_station_name` is null, including match lists and a missing summary).

Common commands:
```
python3 scripts/uk_aq_enrich_station_names_report.py
python3 scripts/uk_aq_enrich_station_names_report.py --limit 50 --matches 10
```

Notes:
- Uses the same enrichment logic as `scripts/uk_aq_enrich_station_names.py` so changes there apply here.
- Always includes pollutants and latest observation details in the outputs.

### `scripts/uk_aq_backfill_timeseries_stations.py`
Purpose:
- Backfill timeseries rows missing station/feature mappings by re-querying SOS metadata.

Common commands:
```
python3 scripts/uk_aq_backfill_timeseries_stations.py
python3 scripts/uk_aq_backfill_timeseries_stations.py --connector-code uk_air_sos --service-ref 1
```

Key flags:
- `--connector-id` or `--connector-code` to scope the backfill.
- `--service-ref` to scope to a specific SOS service within the connector.
- `--batch-size` (default: 200)
- `--limit` to cap total rows processed.
- `--sleep-seconds` (default: 0.2) between API calls.

Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY`

### `scripts/uk_aq_backfill_station_memberships.py`
Purpose:
- Backfill `station_network_memberships` from the UK-AIR monitoring sites register (via `uk_air_sos_site_register` + `uk_air_sos_networks`).
- Store UK-AIR site ids per station in `uk_air_sos_station_refs` for repeatable joins.
- Populate `stations.station_type` with the primary network code (single network or AURN priority).
- Set `station_network_memberships.is_primary` for single-network stations and prioritize AURN.
- Filter memberships by `uk_air_sos_network_pollutants` to align networks with pollutant coverage.
- Use `--source sos` to fall back to SOS stationType values (legacy path).

Common commands:
```
python3 scripts/uk_aq_backfill_station_memberships.py
python3 scripts/uk_aq_backfill_station_memberships.py --service-ref-from-timeseries
python3 scripts/uk_aq_backfill_station_memberships.py --no-filter --limit 500
python3 scripts/uk_aq_backfill_station_memberships.py --source sos
```

Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `UK_AIR_SOS_BASE_URL` (optional override)
Notes:
- Uses the latest `uk_air_sos_site_register.snapshot_at` by default; use `--snapshot-at` to target a specific snapshot.
- Adjust match tolerances with `--match-distance-m` and `--match-distance-no-name-m` if needed.
- Ensure `uk_air_sos_network_pollutants` is populated (via `scripts/uk_air_sos/uk_air_sos_site_register.py --load`).

### `scripts/uk_air_sos/uk_air_sos_site_register.py`
Purpose:
- Download the UK-AIR "Search for monitoring sites" CSV (all sites).
- Use the CSV as the authoritative register for site ids, names, coordinates, and network membership.

Common commands:
```
python3 scripts/uk_air_sos/uk_air_sos_site_register.py --search-url "<search url>" --output uk_air_sos_site_register.csv
python3 scripts/uk_air_sos/uk_air_sos_site_register.py --csv-url "<direct csv url>" --output uk_air_sos_site_register.csv
python3 scripts/uk_air_sos/uk_air_sos_site_register.py --search-url "<search url>" --dropbox-upload
python3 scripts/uk_air_sos/uk_air_sos_site_register.py --search-url "<search url>" --dropbox-upload --load
python3 scripts/uk_air_sos/uk_air_sos_site_register.py --load-only --csv-path /path/to/uk-air-search-results.csv
```

Environment:
- `UK_AIR_SOS_SITE_SEARCH_URL` (optional; used when `--search-url` is omitted)
- `UK_AIR_SOS_SITE_SEARCH_USER_AGENT` (optional)
- `UK_AQ_DROPBOX_ROOT` (required for `--dropbox-upload`)
- `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` (required for `--dropbox-upload`)
- `SUPABASE_URL`, `SB_SECRET_KEY` (required for `--load`/`--load-only`)
Notes:
- The script writes a timestamped filename locally and to Dropbox (e.g., `uk_air_sos_site_register_YYYYMMDDTHHMMSSZ.csv`).
- When `--load` is used, it preserves existing `uk_air_sos_networks.network_display_name` values and upserts `uk_air_sos_network_pollutants`.

### `scripts/uk_air_sos/uk_air_sos_membership_report.py`
Purpose:
- Generate a detailed CSV report for SOS membership backfills (pollutant keys, register networks, allowed/filtered networks, memberships).

Common commands:
```
python3 scripts/uk_air_sos/uk_air_sos_membership_report.py
python3 scripts/uk_air_sos/uk_air_sos_membership_report.py --snapshot-at "<timestamp>"
python3 scripts/uk_air_sos/uk_air_sos_membership_report.py --output network_info/UK-Air-SOS/uk_air_sos_membership_report.csv
```

Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY`

Notes:
- Defaults to the latest `uk_air_sos_site_register.snapshot_at`.
- Writes to `network_info/UK-Air-SOS/` with a timestamped filename when `--output` is omitted.


### `scripts/uk_air_sos/uk_air_sos_list_stations.py`
Purpose:
- Fetch all current stations from UK-AIR SOS.
- Filter to UK bounding box (keeps stations with missing coordinates; `geometry` will be null in Supabase).
- Optional upsert into Supabase.

Common commands:
```
python3 scripts/uk_air_sos/uk_air_sos_list_stations.py
python3 scripts/uk_air_sos/uk_air_sos_list_stations.py --format csv --output uk_stations.csv
python3 scripts/uk_air_sos/uk_air_sos_list_stations.py --to-supabase
python3 scripts/uk_air_sos/uk_air_sos_list_stations.py --no-filter --output uk_aq_stations_all.json
python3 scripts/uk_air_sos/uk_air_sos_list_stations.py --raw-output uk_aq_stations_raw.json
python3 scripts/uk_air_sos/uk_air_sos_list_stations.py --service-id-from-timeseries
python3 scripts/uk_air_sos/uk_air_sos_list_stations.py --check-timeseries-links --check-output uk_air_sos_timeseries_link_check.csv
```

Notes:
- Connector upserts preserve existing `poll_enabled`; new connectors default to `poll_enabled=false`.

Default outputs:
- `uk_air_sos_stations.json`
- `uk_aq_stations_all.json` (when using `--no-filter`)
Optional raw output:
- `--raw-output` writes raw station payloads to a separate JSON file.
Service refs:
- By default, if the SOS reports a single service, that service ref is applied to stations in the JSON output.
- The JSON output also includes a top-level `service_ref` when a single service is detected.
- Use `--service-ref-from-timeseries` (alias `--service-id-from-timeseries`) to resolve `service_ref` from timeseries metadata.
- The internal attribute is named `service_ref_from_timeseries` to match the `_ref` convention; the legacy flag name still works for compatibility.

Notes:
- When `--to-supabase` is enabled, station-name backfills include the existing station metadata needed to satisfy NOT NULL constraints.
- Optional flags: `--skip-station-metadata`, `--skip-network-memberships`, `--skip-station-type-backfill`.
- `--check-timeseries-links` compares payload station_ref/timeseries_ref links against Supabase and writes a CSV report (no data is changed).
- Placeholder SOS station refs (e.g., `9999999999`) are skipped from outputs/upserts and flagged in `station_metadata` with `exclude_from_ui=true`.

Writes to (when `--to-supabase` is set):
- `connectors`, `stations`, `station_metadata`, `station_network_memberships`
- `phenomena`, `procedures`, `offerings` (unless `--skip-metadata` is used)

### `scripts/uk_air_sos/uk_air_sos_timeseries_metadata_sample.py`
Purpose:
- Sample SOS timeseries metadata for a small set of stations and highlight matches for keywords (e.g., modelled wind/temp).

Common commands:
```
python3 scripts/uk_air_sos/uk_air_sos_timeseries_metadata_sample.py
python3 scripts/uk_air_sos/uk_air_sos_timeseries_metadata_sample.py --station-limit 50
python3 scripts/uk_air_sos/uk_air_sos_timeseries_metadata_sample.py --match-terms "model,wind,temperature"
python3 scripts/uk_air_sos/uk_air_sos_timeseries_metadata_sample.py --output network_info/UK-Air-SOS/uk_air_sos_timeseries_metadata_sample.json
```

Default output:
- `network_info/UK-Air-SOS/uk_air_sos_timeseries_metadata_sample_<timestamp>.json`
  - `stations` lifecycle fields: `first_seen_at`, `last_seen_at`, `removed_at`
  - Stations not seen in the current run are marked with `removed_at`.

### `scripts/uk_aq_export_stations_dropbox.py`
Purpose:
- Export a combined stations snapshot from Supabase and upload it to Dropbox.

Output:
- `uk_aq_stations_<timestamp>.json` uploaded to the Dropbox folder (default `uk_aq_stations/<YYYY-MM>`).
- `daily_summary.json` uploaded alongside the stations snapshot (connector/network counts + OpenAQ provider counts).

Environment:
- `SUPABASE_DB_URL` (required; direct Postgres connection)
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`
- `UK_AQ_DROPBOX_ROOT`
- `UK_AQ_STATIONS_DROPBOX_DIR` (optional)

Error logging:

- Writes JSON error logs to `error_log/<YYYY-MM-DD>/uk_aq_error_<timestamp>_<uuid>.json`.
- Uploads the error log to Dropbox under `<UK_AQ_DROPBOX_ROOT>/error_log/<YYYY-MM-DD>/` when credentials are available.


### `scripts/sensorcommunity/sensorcommunity_list_stations.py`
Purpose:
- Fetch all current Sensor.Community stations for `SCOMM_COUNTRY` (default `GB`).
- Filter to UK bounding box (keeps stations with missing coordinates; `geometry` will be null in Supabase).
- Optional upsert into Supabase.

Common commands:
```
python3 scripts/sensorcommunity/sensorcommunity_list_stations.py
python3 scripts/sensorcommunity/sensorcommunity_list_stations.py --format csv --output uk_sensorcommunity_stations.csv
python3 scripts/sensorcommunity/sensorcommunity_list_stations.py --to-supabase
```

Writes to (when `--to-supabase` is set):
- `connectors`, `stations`
Notes:
- Uses `SCOMM_SERVICE_REF` (defaults to `SCOMM_CONNECTOR_CODE`) for `stations.service_ref`.
- Sets `stations.station_exposure` to `indoor`/`outdoor` when `location.indoor` is present.
- Connector upserts preserve existing `poll_enabled`; new connectors default to `poll_enabled=false`.

### `scripts/sensorcommunity/sensorcommunity_backfill_timeseries_phenomena.py`
Purpose:
- Backfill `timeseries.phenomenon_id` for Sensor.Community rows where it is null.
- Uses `timeseries_ref` suffix mapping (for example `:pm10`, `:pm2.5`) and connector-specific `phenomena` rows.
- Intended for maintenance runs outside ingest hot paths.

Common commands:
```
python3 scripts/sensorcommunity/sensorcommunity_backfill_timeseries_phenomena.py
python3 scripts/sensorcommunity/sensorcommunity_backfill_timeseries_phenomena.py --batch-size 2000
```

Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `SCOMM_CONNECTOR_CODE` (optional; defaults to `sensorcommunity`)
- `SCOMM_SERVICE_REF` (optional; defaults to connector code)

### `scripts/sensorcommunity/sensorcommunity_ingest.py`
Purpose:
- Fetch recent Sensor.Community values for `SCOMM_COUNTRY` (default `GB`).
- Read connector + upsert station metadata.
- Insert latest observations for PM10 and PM2.5.

Common commands:
```
python3 scripts/sensorcommunity/sensorcommunity_ingest.py --refresh-recent
python3 scripts/sensorcommunity/sensorcommunity_ingest.py --refresh-recent --raw-output sensorcommunity_raw.json
python3 scripts/sensorcommunity/sensorcommunity_ingest.py --refresh-recent --raw-dropbox
```

Writes to:
- `stations`, `timeseries`, `observations`
Notes:
- Uses `SCOMM_SERVICE_REF` (defaults to `SCOMM_CONNECTOR_CODE`) for `stations.service_ref` and `timeseries.service_ref`.
- Ensures `phenomena` rows for `pm10`/`pm2.5` and sets `timeseries.phenomenon_id`.
- When `SCOMM_INGEST_MET_FIELDS=true`, also ingests `temperature`, `humidity`, and `pressure`.
- `SCOMM_FILE_LOG_LEVEL` controls file log verbosity when raw Dropbox capture is enabled.
- Raw Dropbox uploads are gated by `SCOMM_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (or `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`).
- Dropbox credentials required: `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`.
- Optional folders: `SCOMM_RAW_DROPBOX_FOLDER` (defaults to `/connectors/sensorcommunity/raw_data`) and
  `SCOMM_ERROR_DROPBOX_FOLDER` (defaults to `/error_log`), with `UK_AIR_*` fallbacks.
- Sets `stations.station_exposure` to `indoor`/`outdoor` when `location.indoor` is present.

### `scripts/uk_air_sos/uk_air_sos_compare.py`
Purpose:
- Fetch DEFRA last-hour readings for a station.
- Compare DEFRA values to the latest Supabase observations for the same station.
- Exit non-zero when mismatches exceed the configured tolerance.

Common commands:
```
python3 scripts/uk_air_sos/uk_air_sos_compare.py
python3 scripts/uk_air_sos/uk_air_sos_compare.py --station-id BR11 --tolerance 1.5
python3 scripts/uk_air_sos/uk_air_sos_compare.py --defra-url "https://uk-air.defra.gov.uk/data/site-data?f_site_id=BR11&view=last_hour"
```

Inputs:
- DEFRA last-hour page (HTML)
- `stations`, `timeseries`, `observations`, `phenomena`

Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY`

Output:
- Console report per pollutant (PASS/FAIL) with timestamps/units.
- Exit code 0 on success, 1 on mismatch, 2 on fetch/query errors.

### `scripts/uk_aq_dropbox_test.py`
Purpose:
- Validate Dropbox OAuth refresh token and optionally upload a small test file.

Common commands:
```
python3 scripts/uk_aq_dropbox_test.py
python3 scripts/uk_aq_dropbox_test.py --upload
```

Environment:
- `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`
- Optional `UK_AIR_RAW_DROPBOX_FOLDER` (defaults to `/raw_data`)

### `scripts/uk_aq_error_log_archive.py`
Purpose:
- Zip each day of per-error Dropbox logs into `/error_log/YYYY-MM-DD.zip`.
- Delete the original per-error folder after archiving.
- Delete archived ZIPs older than the retention window (default: 365 days).

Common commands:
```
python3 scripts/uk_aq_error_log_archive.py
python3 scripts/uk_aq_error_log_archive.py --date 2026-01-07
```

Environment:
- `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`
- `SUPABASE_URL` + `UK_AIR_ERROR_DROPBOX_ALLOWED_SUPABASE_URL` (must match to run)
- Optional `UK_AIR_ERROR_DROPBOX_FOLDER` (defaults to `/error_log`)

### `scripts/uk_aq_check_error_logs.py`
Purpose:
- Fetch recent `uk_aq_raw.error_logs` rows for debugging edge-function failures.

Common commands:
```
python3 scripts/uk_aq_check_error_logs.py
python3 scripts/uk_aq_check_error_logs.py --source erg_laqn --since-hours 6 --limit 100
```

Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY`
- Optional `UK_AQ_RAW_SCHEMA` (defaults to `uk_aq_raw`)

### `scripts/gov_uk_waqn/gov_uk_waqn_ingest.py`
Purpose:
- Placeholder for the Wales Air Quality Network ingest pipeline.

Common commands:
```
python3 scripts/gov_uk_waqn/gov_uk_waqn_ingest.py
```

### `scripts/gov_uk_waqn/gov_uk_waqn_list_stations.py`
Purpose:
- Placeholder for the Wales Air Quality Network station listing.

Common commands:
```
python3 scripts/gov_uk_waqn/gov_uk_waqn_list_stations.py
```

### `scripts/erg_laqn/erg_laqn_list_groups.py`
Purpose:
- List available ERG LAQN group names.

Common commands:
```
python3 scripts/erg_laqn/erg_laqn_list_groups.py
python3 scripts/erg_laqn/erg_laqn_list_groups.py --format json
```

Environment:
- `LAQN_BASE_URL` (optional; defaults to `https://api.erg.ic.ac.uk/AirQuality`)
- `LAQN_USER_AGENT` (optional)

### `scripts/breathelondon/breathelondon_ingest.py`
Purpose:
- Ingest Breathe London Communities observations using staged checkpoints in Supabase.
- Pulls IPM25 and INO2 data per site and stores checkpoints in `breathelondon_timeseries_checkpoints`.

Common commands:
```
python3 scripts/breathelondon/breathelondon_ingest.py
python3 scripts/breathelondon/breathelondon_ingest.py --initial-days 30 --window-hours 12
python3 scripts/breathelondon/breathelondon_ingest.py --limit 5 --dry-run
python3 scripts/breathelondon/breathelondon_ingest.py --skip-stations --limit 5 --dry-run --window-hours 1
python3 scripts/breathelondon/breathelondon_ingest.py --limit 5 --dry-run --output-timeseries network_info/breathelondon_timeseries.json --output-observations network_info/breathelondon_observations.json --output-checkpoints network_info/breathelondon_checkpoints.json
python3 scripts/breathelondon/breathelondon_ingest.py --skip-stations --limit 5 --dry-run --ignore-checkpoints --start-date 2026-01-19T01:00:00Z --window-hours 12
python3 scripts/breathelondon/breathelondon_ingest.py --skip-stations --recent-stations --limit 5 --dry-run
```

Environment:
- `BREATHELONDON_API_KEY`
- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `BREATHELONDON_BASE_URL` (optional override)
- `BREATHELONDON_CONNECTOR_CODE` / `BREATHELONDON_SERVICE_REF` (optional override)
- `BREATHELONDON_SERVICE_LABEL` (optional override)
- `BREATHELONDON_USER_AGENT` (optional override)

Notes:
- `--skip-stations` skips `ListSensors` and loads station refs from Supabase instead.
- `--output-timeseries` / `--output-observations` write JSON snapshots (best paired with `--limit`).
- `--output-checkpoints` writes the checkpoint rows pulled from Supabase.
- `--ignore-checkpoints` forces backfill even when checkpoints already exist (use for dry-run testing).
- `--recent-stations` picks stations with the most recent `timeseries.last_value_at` when used with `--skip-stations` (falls back to `observations` if needed).
- Updates `connectors.last_polled_at` on successful non-dry runs.

### `scripts/breathelondon/breathelondon_batch.py`
Purpose:
- Batch station refs from Supabase and invoke `ingest_breathelondon` per chunk.
- Used by GitHub Actions to avoid edge runtime limits.

Common commands:
```
python3 scripts/breathelondon/breathelondon_batch.py --connector-code breathelondon --batch-size 10 --active-only --skip-stations
```

Environment:
- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `SB_PUBLISHABLE_DEFAULT_KEY`
- `SB_UK_AQ_CRON_SECRET` (optional)
- `BREATHELONDON_CONNECTOR_CODE` (optional override)
- `BREATHELONDON_SERVICE_REF` (optional override)

Notes:
- `--active-only` honors `station_metadata.attributes.enabled` or `station_metadata.attributes.site_active`.
- `--skip-stations` avoids `ListSensors` and uses the Supabase station list instead.
- Stations are ordered by `breathelondon_station_checkpoints.last_polled_at` (nulls first), then `next_due_at`.

### `scripts/breathelondon/breathelondon_list_stations.py`
Purpose:
- Fetch Breathe London station metadata and optionally upsert stations + metadata in Supabase.

Common commands:
```
python3 scripts/breathelondon/breathelondon_list_stations.py
python3 scripts/breathelondon/breathelondon_list_stations.py --format csv --output uk_breathelondon_stations.csv
python3 scripts/breathelondon/breathelondon_list_stations.py --to-supabase
```

Environment:
- `BREATHELONDON_API_KEY`
- `SUPABASE_URL` (required for `--to-supabase`)
- `SB_SECRET_KEY` (required for `--to-supabase`)
- `BREATHELONDON_BASE_URL` (optional override)
- `BREATHELONDON_CONNECTOR_CODE` / `BREATHELONDON_SERVICE_REF` (optional override)
- `BREATHELONDON_SERVICE_LABEL` (optional override)
- `BREATHELONDON_USER_AGENT` (optional override)

Notes:
- Connector upserts preserve existing `poll_enabled`; new connectors default to `poll_enabled=false`.

### `scripts/uk_aq_invoke_edge.py`
Purpose:
- Invoke Supabase Edge Functions (one at a time) for ad-hoc testing.

Common commands:
```
python3 scripts/uk_aq_invoke_edge.py --function ingest_breathelondon --connector-code breathelondon
python3 scripts/uk_aq_invoke_edge.py --function ingest_sensorcommunity --connector-code sensorcommunity --payload '{"dry_run":true}'
python3 scripts/uk_aq_invoke_edge.py --function uk_aq_latest --connector-code breathelondon --method GET --params '{"limit":5}'
```

Environment:
- `SUPABASE_URL`
- `SB_PUBLISHABLE_DEFAULT_KEY`
- `SB_UK_AQ_CRON_SECRET` (required for ingest functions when set in Supabase)

### `scripts/uk_aq_station_duplicate_candidates.py`
Purpose:
- Build pollutant-aware possible duplicate station/timeseries groups from latest station JSON + latest AURN register CSV.
- Uses DB-backed station/timeseries IDs (`uk_aq_core.timeseries`) and writes one long-format CSV for review.

Common commands:
```bash
python3 scripts/uk_aq_station_duplicate_candidates.py
python3 scripts/uk_aq_station_duplicate_candidates.py \
  --distance-m 30 \
  --min-group-size 2
```

Output:
- `plans/uk_aq_station_duplicate_candidates_long.csv`

Notes:
- JSON station rows are expanded to all DB timeseries for that station before duplicate grouping.
- Duplicate groups are pollutant-aware and must contain at least two different connectors.
- Groups are excluded when every row has blank `last_value`.

## SOS metadata glossary
- `phenomenon`: The observed property (pollutant/parameter), e.g., NO2, O3, PM2.5.
- `procedure`: The sensor or measurement method used to produce the observation.
- `offering`: A logical grouping of observations, often representing a dataset or station-level collection.

## Keys
- `stations` uses bigint `id` with `station_ref` for upstream identifiers (unique by `connector_id, service_ref, station_ref`).
- `timeseries` uses integer `id` with `timeseries_ref` for upstream identifiers (unique by `connector_id, service_ref, timeseries_ref`).
- `observations` references `timeseries.id` (integer) and uses `(connector_id, timeseries_id, observed_at)` as the primary key.
- `connectors.id` and all `connector_id` FKs are integer. External identifiers that arrive as text (even if numeric) use `*_ref`; internal joins use `*_id`.

### `scripts/codeql_alerts_export.py`
Purpose:
- Export open GitHub CodeQL code-scanning alerts and per-alert instance locations using the REST API.
- Write deterministic local snapshots for batching/remediation planning.

Common commands:
```bash
python3 scripts/codeql_alerts_export.py
python3 scripts/codeql_alerts_export.py --repo ChronicChannel-test/uk-aq-ingest --state open --per-page 100
```

Notes:
- Auth order: `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token` fallback.
- Permission diagnostics are explicit for GitHub API failures (401/403/404) with fine-grained PAT guidance.
- Output defaults to `.codeql/exports/<YYYY-MM-DD>/alerts.json` plus `instances/<alert_number>.json`.

### `scripts/codeql_batch.py`
Purpose:
- Convert exported CodeQL alerts into deterministic remediation batches.
- Sort by severity, then rule ID, then alert number.

Common commands:
```bash
python3 scripts/codeql_batch.py --batch-size 10
python3 scripts/codeql_batch.py --batch-size 10 --max-batches 2
```

Notes:
- Uses `most_recent_instance` when available, else falls back to exported instance files.
- Output defaults to `.codeql/batches/<YYYY-MM-DD>/batch-XX.json`.

### `scripts/codeql_make_task_specs.py`
Purpose:
- Generate per-batch markdown remediation specs to seed follow-up Codex fix tasks.

Common commands:
```bash
python3 scripts/codeql_make_task_specs.py --batches-dir .codeql/batches/<YYYY-MM-DD>
python3 scripts/codeql_make_task_specs.py --batches-dir .codeql/batches/<YYYY-MM-DD> --batch batch-01.json
```

Notes:
- Output defaults to `.codeql/task-specs/<YYYY-MM-DD>/batch-XX.md`.
- Specs include scope, strict change rules, verification steps, and PR instructions.
