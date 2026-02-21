# GitHub Actions

This repo uses GitHub Actions for scheduled syncs and deployments.

Env target routing for GitHub sync:
- `scripts/uk_aq_sync_github_secrets.sh` uses `config/uk_aq_github_env_targets.csv`
  to decide if a key syncs to GitHub `secret`, `variable`, `both`, or `local`.
- Keep this mapping file updated whenever workflow references move between
  `vars.KEY` and `secrets.KEY`.
- Unmapped keys default to `local` and are not synced to GitHub.
- Cloud Run deploy workflows use vars-first with secret fallback for non-sensitive
  config (`vars.KEY || secrets.KEY`) so migration from Secrets to Variables is
  non-breaking.

Cloud Run deploy idempotency:
- `scripts/gcp/uk_aq_secret_upsert_if_changed.sh` only creates a new secret
  version when content changes.
- Deploy workflows diff the current Cloud Run job before update and skip
  `gcloud run jobs update` when image/env/secret/label config is unchanged.
- Deploy updates use `--set-secrets` to replace secret bindings, which removes
  stale bindings from prior revisions.
- Deploy updates apply `--update-labels "job_name=<job>"` and verify the
  deployed job label after each run.

## Workflows

### `supabase-keepalive.yml`
- Schedule: daily at 06:00 UTC.
- Purpose: run a lightweight keepalive query against Supabase.
- Script: `npm run keepalive`.
- Secrets: `SUPABASE_URL`, `SB_PUBLISHABLE_DEFAULT_KEY`, `KEEPALIVE_TABLE`, `KEEPALIVE_SELECT`.

### `supabase_edge_deploy.yml`
- Trigger: push to `main` affecting `supabase/functions/**`, or manual dispatch.
- Purpose: inject Supabase project ref into the web page, set Supabase secrets, deploy edge functions.
- Deployed functions: `ingest_uk_air_sos`, `ingest_breathelondon`, `ingest_sensorcommunity`,
  `uk_aq_dispatch_polls`, `uk_aq_latest`,
  `uk_aq_stations_chart`, `uk_aq_la_hex`, `uk_aq_pcon_hex`,
  `uk_aq_stations`, `uk_aq_timeseries`.
- Secrets: `SUPABASE_PROJECT_REF`, `SB_PUBLISHABLE_DEFAULT_KEY`, `SUPABASE_ACCESS_TOKEN`,
  `SUPABASE_SECRETS_ENV` (newline-delimited env file contents).
- Supabase secret names cannot start with `SUPABASE_`. Use `SB_` (or another prefix) in
  `SUPABASE_SECRETS_ENV`.

Example `SUPABASE_SECRETS_ENV` content:
```
SB_SUPABASE_URL=...
SB_SECRET_KEY=...
SB_SECRET_KEY=...   # preferred for new key model
SB_PUBLISHABLE_DEFAULT_KEY=...
SB_UK_AQ_CRON_SECRET=...
```

### `uk_aq_egress_monitor.yml`
- Trigger: schedule every 5 minutes, or manual dispatch.
- Purpose: trigger `uk_aq_egress_monitor` against the main ingest Supabase project and record top endpoint/caller egress totals.
- Auth/config:
  - `vars.SUPABASE_URL`
  - `secrets.SB_PUBLISHABLE_DEFAULT_KEY`
  - optional `secrets.SB_UK_AQ_CRON_SECRET` header.

### `uk_aq_history_egress_monitor.yml`
- Trigger: schedule every 5 minutes, or manual dispatch.
- Purpose: trigger `uk_aq_egress_monitor` against the history Supabase project for history-side endpoint/caller egress visibility.
- Auth/config:
  - `vars.HISTORY_SUPABASE_URL`
  - `secrets.HISTORY_PUBLISHABLE_DEFAULT_KEY`
  - optional `secrets.SB_UK_AQ_CRON_SECRET` header.

### `uk_aq_history_edge_deploy.yml`
- Trigger: manual dispatch; push to `supabase/functions/uk_aq_egress_monitor/**`, `supabase/config.toml`, or this workflow.
- Purpose: deploy `uk_aq_egress_monitor` to the history Supabase project with `verify_jwt` disabled (`--no-verify-jwt`) so monitor invocations can use publishable key + cron secret only.
- Auth/config:
  - `secrets.SUPABASE_ACCESS_TOKEN`
  - `vars.HISTORY_SUPABASE_URL`
  - `secrets.HISTORY_SECRET_KEY`
  - optional `secrets.SB_UK_AQ_CRON_SECRET`

### `uk_aq_raw_dropbox.yml`
- Trigger: manual dispatch.
- Purpose: run a Bristol-only ingest with raw Dropbox upload for debugging/testing.
- Script: `python3 scripts/uk_air_sos/uk_air_sos_ingest.py --discover --refresh-recent ... --raw-dropbox`.
- Secrets: `SUPABASE_URL`, `SB_SECRET_KEY`, `DROPBOX_APP_KEY`,
  `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`.

### `uk_aq_breathelondon_batch.yml`
- Schedule: manual only (cron handles production batch polling).
- Purpose: batch station refs and invoke `ingest_breathelondon` per chunk for manual runs.
- Script: `python3 scripts/breathelondon/breathelondon_batch.py --connector-code breathelondon --batch-size 10 --active-only --skip-stations`.
- Order: `breathelondon_station_checkpoints.last_polled_at` asc (nulls first), then `next_due_at` asc.
- Secrets: `SUPABASE_URL`, `SB_SECRET_KEY`, `SB_PUBLISHABLE_DEFAULT_KEY`, `SB_UK_AQ_CRON_SECRET`.

### `uk_aq_stations_daily.yml`
- Schedule: daily at 03:00 UTC.
- Purpose: sync stations to Supabase (UK-AIR SOS + Breathe London) and export a combined stations snapshot to Dropbox.
- Script: `python3 scripts/uk_air_sos/uk_air_sos_list_stations.py --to-supabase`.
- Script: `python3 scripts/breathelondon/breathelondon_list_stations.py --to-supabase`.
- Script: `python3 scripts/uk_aq_refresh_station_geo_aiven.py` (refresh PCON/LA codes from Aiven).
- Export: `python3 scripts/uk_aq_export_stations_dropbox.py` (uploads `uk_aq_stations_<timestamp>.json`).
- Optional: Sensor.Community discovery step (disabled by default).
- Secrets: `SUPABASE_URL`, `SB_SECRET_KEY`, `UK_AIR_SOS_BASE_URL`,
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
  `SUPABASE_URL`, `SB_PUBLISHABLE_DEFAULT_KEY`, `SB_UK_AQ_CRON_SECRET`.
- Deploy sequence:
  1. Deploy current Worker code (`Deploy Worker (base)`).
  2. Apply all three secrets in one `wrangler secret bulk` call (with retry).
  3. Deploy again (`Deploy Worker`) so code + updated secrets are active together.
- Why bulk secrets: avoids Cloudflare Worker Versions failure seen with multiple sequential
  `wrangler secret put` calls in one run.

### `uk_aq_history_outbox_cloud_run_deploy.yml`
- Trigger: push to `main` affecting `workers/uk_aq_history_outbox_cloud_run/**`, or manual dispatch.
- Also watches shared egress patch/runtime files:
  - `supabase/functions/_shared/fetch_egress_patch.ts`
  - `supabase/functions/_shared/egress_metrics.ts`
  - `supabase/functions/_shared/history_client.ts`
- Purpose: deploy the dedicated Cloud Run job that flushes history outbox on a 10-minute schedule.
- Job: `workers/uk_aq_history_outbox_cloud_run`.
- Runtime:
  - Small per-batch claims, bounded runtime budget, and retry-aware RPC calls.
  - Scheduler target uses Google Cloud Scheduler -> Cloud Run Jobs API (`:run`).
- Secrets:
  - `SUPABASE_URL`, `SB_SECRET_KEY` (preferred; workflow falls back to `SB_SECRET_KEY`),
  - `HISTORY_SUPABASE_URL`, `HISTORY_SECRET_KEY`,
  - GCP deploy/auth secrets as in other Cloud Run workflows.

### `uk_aq_history_pubsub_cloud_run_deploy.yml`
- Trigger: push to `main` affecting `workers/uk_aq_history_pubsub_cloud_run/**`, or manual dispatch.
- Also watches shared egress patch/runtime files:
  - `supabase/functions/_shared/fetch_egress_patch.ts`
  - `supabase/functions/_shared/egress_metrics.ts`
  - `supabase/functions/_shared/history_client.ts`
- Purpose: deploy the hourly-triggered Cloud Run service that drains history Pub/Sub messages and writes mixed-row batches to history DB.
- Default service name: `uk-aq-history-pubsub-writer`.
- Worker: `workers/uk_aq_history_pubsub_cloud_run`.
- Runtime:
  - Pulls from one Pub/Sub subscription.
  - Merges rows across connectors, deduplicates by `(connector_id, timeseries_id, observed_at)`, and upserts in chunks.
  - Acknowledges messages only after successful upsert + receipt write.
- Pub/Sub setup:
  - Ensures topic + subscription exist.
  - Grants writer runtime service account `roles/pubsub.subscriber` on the subscription.
- Scheduler:
  - Uses Google Cloud Scheduler -> Cloud Run service URL with OIDC auth.
  - Default cron is hourly (`0 * * * *`).

### `uk_aq_breathelondon_cloud_run_deploy.yml`
- Trigger: push to `main` affecting `workers/uk_aq_breathelondon_cloud_run/**` or Breathe London ingest runtime files, or manual dispatch.
- Purpose: deploy the Breathe London Cloud Run service + optional Cloud Scheduler trigger.
- Default service name: `uk-aq-breathelondon-ingest`.
- Worker: `workers/uk_aq_breathelondon_cloud_run`.
- Scheduler:
  - Uses Google Cloud Scheduler -> Cloud Run Service URL with OIDC auth.
  - Frequency is configurable (`GCP_BREATHELONDON_SCHEDULER_CRON`), while effective poll cadence still comes from connector interval checks in the worker.
- Required secrets/vars:
  - `GCP_PROJECT_ID`, Google auth secrets (`GCP_WORKLOAD_IDENTITY_PROVIDER` + `GCP_SERVICE_ACCOUNT` or `GCP_SA_KEY`)
  - `GCP_BREATHELONDON_SERVICE_ACCOUNT` (or legacy `GCP_BREATHELONDON_JOB_SERVICE_ACCOUNT`)
  - `SUPABASE_URL`, `SB_SECRET_KEY` (preferred; workflow falls back to `SB_SECRET_KEY`)
  - `BREATHELONDON_API_KEY`
- Optional:
  - `HISTORY_SUPABASE_URL`, `HISTORY_SECRET_KEY` (required only for `HISTORY_WRITE_MODE=direct`; not injected for `pubsub_only`/`outbox_only`)
  - `BREATHELONDON_HISTORY_WRITE_MODE` (workflow default `pubsub_only`)
  - `GCP_HISTORY_PUBSUB_TOPIC`, `HISTORY_PUBSUB_PUBLISH_BATCH_SIZE`
  - `SB_UK_AQ_CRON_SECRET`
  - Dropbox secrets (`DROPBOX_*`) and raw-upload allowlist env (`BREATHELONDON_RAW_DROPBOX_ALLOWED_SUPABASE_URL` or legacy `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`)

### `uk_aq_uk_air_sos_cloud_run_deploy.yml`
- Trigger: push to `main` affecting `workers/uk_aq_uk_air_sos_cloud_run/**` or SOS ingest runtime files, or manual dispatch.
- Purpose: deploy the UK-AIR SOS Cloud Run service + optional Cloud Scheduler trigger.
- Default service name: `uk-aq-sos-ingest`.
- Worker: `workers/uk_aq_uk_air_sos_cloud_run`.
- Scheduler:
  - Uses Google Cloud Scheduler -> Cloud Run Service URL with OIDC auth.
  - Frequency is configurable (`GCP_UK_AIR_SOS_SCHEDULER_CRON`), while effective poll cadence still comes from connector interval checks in the worker.
- Required secrets/vars:
  - `GCP_PROJECT_ID`, Google auth secrets (`GCP_WORKLOAD_IDENTITY_PROVIDER` + `GCP_SERVICE_ACCOUNT` or `GCP_SA_KEY`)
  - `GCP_UK_AIR_SOS_SERVICE_ACCOUNT` (or legacy `GCP_UK_AIR_SOS_JOB_SERVICE_ACCOUNT`)
  - `SUPABASE_URL`, `SB_SECRET_KEY` (preferred; workflow falls back to `SB_SECRET_KEY`)
- Optional:
  - `HISTORY_SUPABASE_URL`, `HISTORY_SECRET_KEY` (required only for `HISTORY_WRITE_MODE=direct`; not injected for `pubsub_only`/`outbox_only`)
  - `UK_AIR_SOS_HISTORY_WRITE_MODE` (workflow default `pubsub_only`)
  - `GCP_HISTORY_PUBSUB_TOPIC`, `HISTORY_PUBSUB_PUBLISH_BATCH_SIZE`
  - `SB_UK_AQ_CRON_SECRET`
  - Dropbox secrets (`DROPBOX_*`) and raw-upload allowlist env (`UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`).

### `uk_aq_openaq_cloud_run_deploy.yml`
- Trigger: push to `main` affecting `workers/uk_aq_openaq_cloud_run/**` or OpenAQ ingest runtime files, or manual dispatch.
- Purpose: deploy the OpenAQ Cloud Run job + due-driven Cloud Tasks trigger + safety Cloud Scheduler trigger.
- Default job name: `uk-aq-openaq-ingest`.
- Worker: `workers/uk_aq_openaq_cloud_run`.
- Trigger model:
  - Primary: one-off Cloud Tasks created by the OpenAQ Cloud Run worker based on earliest due `openaq_station_checkpoints.next_due_at`.
  - Safety: Cloud Scheduler cron (workflow default `*/30 * * * *`) calls the job with `OPENAQ_TRIGGER_MODE=safety`.
  - In safety mode, worker checks latest successful OpenAQ run in the last `OPENAQ_SAFETY_SUCCESS_LOOKBACK_MINUTES` (default `10`): recent success => no-op; stale success => run.
- Required secrets/vars:
  - `GCP_PROJECT_ID`, Google auth secrets (`GCP_WORKLOAD_IDENTITY_PROVIDER` + `GCP_SERVICE_ACCOUNT` or `GCP_SA_KEY`)
  - `GCP_OPENAQ_JOB_SERVICE_ACCOUNT` (repo var or secret)
  - `SUPABASE_URL`, `SB_SECRET_KEY` (preferred; workflow falls back to `SB_SECRET_KEY`)
  - `OPENAQ_API_KEY`
- Optional:
  - `HISTORY_SUPABASE_URL`, `HISTORY_SECRET_KEY` (required only for `HISTORY_WRITE_MODE=direct`; not injected for `pubsub_only`/`outbox_only`)
  - `OPENAQ_HISTORY_WRITE_MODE` (workflow default `pubsub_only` for direct history Pub/Sub publishing)
  - `GCP_HISTORY_PUBSUB_TOPIC`, `HISTORY_PUBSUB_PUBLISH_BATCH_SIZE`
  - `SB_UK_AQ_CRON_SECRET`
  - Dropbox secrets (`DROPBOX_*`) and raw-upload allowlist env (`OPENAQ_RAW_DROPBOX_ALLOWED_SUPABASE_URL` or legacy `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`)
  - `GCP_OPENAQ_TASK_QUEUE_ID`, `GCP_OPENAQ_TASK_INVOKER_SERVICE_ACCOUNT`, `GCP_OPENAQ_SCHEDULER_SERVICE_ACCOUNT`.

### `uk_aq_scomm_cloud_run_deploy.yml`
- Trigger: push to `main` affecting `workers/uk_aq_sensorcommunity_cloud_run/**`, or manual dispatch.
- Purpose: deploy the Sensor.Community Cloud Run service and configure history write mode/env.
- Default service name: `uk-aq-scomm-ingest`.
- Worker: `workers/uk_aq_sensorcommunity_cloud_run`.
- Scheduler:
  - Uses Google Cloud Scheduler -> Cloud Run Service URL with OIDC auth.
  - Reuses existing scheduler cadence/timezone where present, otherwise creates `uk-aq-scomm-trigger` on `*/2 * * * *` UTC.
- Labels:
  - Sets and verifies `job_name=uk-aq-scomm-ingest-service` on the service for billing/report grouping.
- Required secrets/vars:
  - `GCP_PROJECT_ID`, Google auth secrets (`GCP_WORKLOAD_IDENTITY_PROVIDER` + `GCP_SERVICE_ACCOUNT` or `GCP_SA_KEY`)
  - `GCP_SCOMM_JOB_SERVICE_ACCOUNT` (runtime service account used by Cloud Run service)
  - `SUPABASE_URL`, `SB_SECRET_KEY` (preferred; workflow falls back to `SB_SECRET_KEY`)
- Optional:
  - `HISTORY_SUPABASE_URL`, `HISTORY_SECRET_KEY` (required only for `HISTORY_WRITE_MODE=direct`; not injected for `pubsub_only`/`outbox_only`)
  - `SCOMM_HISTORY_WRITE_MODE` (workflow default `pubsub_only`)
  - `GCP_HISTORY_PUBSUB_TOPIC`, `HISTORY_PUBSUB_PUBLISH_BATCH_SIZE`
  - Dropbox secrets (`DROPBOX_*`) and raw-upload allowlist env (`SCOMM_RAW_DROPBOX_ALLOWED_SUPABASE_URL` / `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`)

### `uk_aq_validate_github_env_targets.yml`
- Trigger: push/PR/manual when workflows, sync script, or env target map changes.
- Purpose: enforce that `config/uk_aq_github_env_targets.csv` matches workflow
  usage:
  - `vars.KEY` only -> mapping must be `variable`
  - `secrets.KEY` only -> mapping must be `secret`
  - both references -> mapping must be `both`
- Fails CI when a referenced key is missing from the mapping or mapped to the
  wrong target.

### `uk_air_sos_site_register_monthly.yml`
- Schedule: monthly on day 1 at 04:15 UTC.
- Purpose: download the UK-AIR monitoring sites CSV via the search page.
- Script: `python3 scripts/uk_air_sos/uk_air_sos_site_register.py --output uk_air_sos_site_register.csv`.
- Output: uploads a timestamped CSV to Dropbox at `network_info/uk_air_sos` and loads it into Supabase.
- Secrets: `UK_AIR_SOS_SITE_SEARCH_URL`, `UK_AIR_SOS_SITE_SEARCH_USER_AGENT` (optional),
  `UK_AQ_DROPBOX_ROOT`, `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`,
  `SUPABASE_URL`, `SB_SECRET_KEY`.
