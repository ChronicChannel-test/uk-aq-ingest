# UK AQ Dashboard System

This document describes how the local UK AQ dashboard works in ingest, where it gets data from, and how storage/backup status is derived.

## Scope

Dashboard components in this repo:

- Backend API server: `scripts/uk_aq_dashboard_local.py`
- Frontend UI: `data/uk_aq_dashboard/uk_aq_dashboard.html`
- Static assets: `data/uk_aq_dashboard/*` (for example `dropbox-icon.svg`, served via `/assets/...`)

This dashboard is a local service (typically run from `dev_dashboards.sh`), not a hosted production web service.

## Runtime Topology

Browser -> local Python server -> data sources:

1. Supabase PostgREST (ingestdb and obs_aqidb).
2. Supabase RPC (`uk_aq_rpc_r2_history_window` by default).
3. External DB size API (optional, if configured).
4. Cloudflare APIs for R2 account usage.
5. Local Dropbox checkpoint JSON file (for Dropbox backup status badges).

## HTTP Endpoints

Served by `scripts/uk_aq_dashboard_local.py`:

- `GET /` and `GET /index.html`
  - Serves the dashboard HTML.
- `GET /assets/<file>`
  - Serves static files from `data/uk_aq_dashboard/`.
  - Path traversal is blocked; only files under that directory are served.
- `GET /api/dashboard`
  - Main payload for dashboard panels.
  - Query params:
    - `force=1|true|yes|on`: clear dashboard + storage coverage cache before rebuilding.
    - `dispatch_cursor=<timestamp>`: incremental dispatch feed fetch.
- `GET /api/r2_metrics`
  - Returns R2 usage + R2 history window.
  - Query params:
    - `force=1|true|yes|on`: force R2 usage cache refresh.
- `POST /api/connectors`
  - Updates connector poll settings in `connectors`.
- `POST /api/dispatcher_settings`
  - Updates `dispatcher_settings` row (`id=1`).

## Data Sources by Panel

### 1) Pollutant freshness panels

Sources (ingestdb):

- `connectors`
- `stations`
- `station_metadata`
- `timeseries` (+ joined `phenomena`)

How:

- Uses `last_value_at` to bucket station freshness (`0-3h`, `3-6h`, `6-24h`, `1-7d`, `>7d`).
- Applies connector-specific exclusions (`pm10` excludes Breathe London, `no2` excludes Sensor.Community).
- Active-station rules include connector-specific logic (for Breathe London, checks metadata flags).

### 2) Dispatch runs panel

Sources (ingestdb):

- `uk_aq_ingest_runs`
- `connectors` fallback fields for in-flight display

How:

- Maintains incremental in-memory run cache with overlap window.
- Adds synthetic `in_flight` rows when a connector run has start time but no end time.

### 3) DB size and schema/domain size charts

Primary source (preferred):

- `UK_AQ_DB_SIZE_API_URL` endpoint returning:
  - `db_size_metrics`
  - `schema_size_metrics`
  - `r2_domain_size_metrics`

Fallback source (direct Supabase reads):

- Ingest DB view `uk_aq_public.uk_aq_db_size_metrics_hourly` for `ingestdb`.
- Obs AQI DB view `uk_aq_public.uk_aq_db_size_metrics_hourly` for `obs_aqidb`.
- Obs AQI DB view `uk_aq_public.uk_aq_schema_size_metrics_hourly` for:
  - `uk_aq_observs`
  - `uk_aq_aqilevels`
- Ingest DB view `uk_aq_public.uk_aq_r2_domain_size_metrics_hourly` for:
  - `observations`
  - `aqilevels`

If primary source fails or is stale, backend reports warning fields and uses fallback.

### 4) R2 account usage panel

Source:

- Cloudflare account APIs using:
  - `CLOUDFLARE_ACCOUNT_ID`
  - `CFLARE_API_READ_TOKEN`

How:

- Gets storage and operation usage from Cloudflare GraphQL.
- If storage analytics are empty/zero, falls back to Cloudflare R2 metrics REST endpoint.

### 5) Storage coverage calendar (monthly/yearly)

Inputs:

- Latest `oldest_observed_at` from DB/schema metrics.
- R2 window RPC:
  - default RPC name: `uk_aq_rpc_r2_history_window`
  - env override: `UK_AQ_R2_HISTORY_WINDOW_RPC`
- Latest R2 domain size samples (`observations`, `aqilevels`).
- Dropbox checkpoint day maps (local JSON file; details below).

Rules:

- `r2_aqilevels` is only shown if latest `aqilevels` R2 domain size is non-zero.
- Today rendering differs by view:
  - Monthly: today shown as half-width bars.
  - Yearly: today excluded (complete-day model).

## Dropbox Status in Monthly Calendar

Monthly bars can show a second line (`Dropbox` + icon) when that day/domain exists in backup checkpoint state.

Checkpoint schema used:

- `domains.observations.days.<YYYY-MM-DD>`
- `domains.aqilevels.days.<YYYY-MM-DD>`

If a day key exists for a domain, that domain bar on that day gets Dropbox second line.

Important:

- Dashboard does not call Dropbox API directly.
- It reads a local JSON checkpoint file only.

### Local vs GH behavior

- Local machine:
  - Works if checkpoint file exists in local filesystem (for example synced Dropbox folder).
- GitHub runner:
  - No automatic Dropbox read.
  - To show Dropbox status in GH-run dashboard, provide the checkpoint file on runner filesystem and point dashboard env to it.
  - Otherwise, dashboard runs normally but without Dropbox second-line labels.

## Dropbox Checkpoint Path Resolution

Resolution order:

1. `UK_AQ_R2_HISTORY_DROPBOX_STATE_FILE` (explicit absolute or relative path).
2. Derived path:
   - `<UK_AQ_DROPBOX_LOCAL_ROOT>/<UK_AQ_DROPBOX_ROOT>/<UK_AQ_R2_HISTORY_DROPBOX_DIR>/<UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH>`
3. Dropbox app-folder derived path(s):
   - `<UK_AQ_DROPBOX_LOCAL_ROOT>/Apps/<UK_AQ_DROPBOX_APP_FOLDER>/<UK_AQ_DROPBOX_ROOT>/<UK_AQ_R2_HISTORY_DROPBOX_DIR>/<UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH>`
   - If `UK_AQ_DROPBOX_APP_FOLDER` is unset, dashboard scans `.../Apps/*/` (prefers `github-uk-air-quality-networks` first).
4. If `UK_AQ_DROPBOX_LOCAL_ROOT` is unset, default local root candidate:
   - `~/Library/CloudStorage/Dropbox`

Defaults:

- `UK_AQ_DROPBOX_ROOT=CIC-Test`
- `UK_AQ_R2_HISTORY_DROPBOX_DIR=R2_history_backup`
- `UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH=_ops/checkpoints/r2_history_backup_state_v1.json`

## Caching Model

- Dashboard payload cache (`/api/dashboard`):
  - `CACHE_TTL_SECONDS=20`.
- R2 usage cache:
  - `R2_CACHE_TTL_SECONDS=3600` (1 hour).
- Storage coverage cache:
  - Refreshes at next `COVERAGE_REFRESH_HOUR_UTC` boundary (currently 05:00 UTC).
  - `force` refresh clears cache immediately.
- Dispatch runs:
  - Incremental in-memory merge with overlap and max-row cap.

## Security and Guardrails

- Requires service-role key (`SB_SECRET_KEY` role must be `service_role`).
- Base URL host restricted to:
  - `localhost` / `127.0.0.1`
  - `*.supabase.co`
  - `*.supabase.in`
- PostgREST writes are limited to known endpoints (`connectors`, `dispatcher_settings`) in this server code path.

## Environment Variables

Required:

- `SUPABASE_URL`
- `SB_SECRET_KEY` (service role)

DB size / metrics:

- `UK_AQ_DB_SIZE_LOOKBACK_DAYS` (default `28`)
- `UK_AQ_DB_SIZE_API_URL` (optional)
- `UK_AQ_DB_SIZE_API_TOKEN` (optional)
- `OBS_AQIDB_SUPABASE_URL` (optional fallback)
- `OBS_AQIDB_SECRET_KEY` (optional fallback)
- `UK_AQ_PUBLIC_SCHEMA` (default `uk_aq_public`)

R2 window / usage:

- `UK_AQ_R2_HISTORY_WINDOW_RPC` (default `uk_aq_rpc_r2_history_window`)
- `CLOUDFLARE_ACCOUNT_ID`
- `CFLARE_API_READ_TOKEN`
- `UK_AQ_R2_FREE_TIER_GB` (default `10`)
- `UK_AQ_R2_FREE_TIER_CLASS_A_REQUESTS` (default `1000000`)
- `UK_AQ_R2_FREE_TIER_CLASS_B_REQUESTS` (default `10000000`)

Dropbox checkpoint (monthly backup second-line labels):

- `UK_AQ_R2_HISTORY_DROPBOX_STATE_FILE` (explicit path; preferred when set)
- `UK_AQ_DROPBOX_LOCAL_ROOT` (optional local root override)
- `UK_AQ_DROPBOX_APP_FOLDER` (optional app-folder name under `.../Dropbox/Apps/` for app-folder tokens)
- `UK_AQ_DROPBOX_ROOT` (default `CIC-Test`)
- `UK_AQ_R2_HISTORY_DROPBOX_DIR` (default `R2_history_backup`)
- `UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH` (default `_ops/checkpoints/r2_history_backup_state_v1.json`)

Dispatch feed behavior:

- `DISPATCH_OBSERVS_WINDOW_MINUTES` (default `240`)
- `DISPATCH_FETCH_LIMIT` (default `1000`)
- `DISPATCH_INCREMENTAL_OVERLAP_SECONDS` (default `120`)
- `DISPATCH_MAX_ROWS` (default `5000`)

## Operational Notes

- `dev_dashboards.sh` exports `.env` and `.env.supabase` before launching Python; this is the recommended way to run locally.
- If the DB size API is down, dashboard falls back to direct Supabase metric reads and emits warning strings in payload.
- If Dropbox checkpoint is missing, unreadable, or malformed, only Dropbox status labels are affected; core dashboard remains available.
