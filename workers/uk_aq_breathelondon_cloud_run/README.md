# uk_aq Breathe London Cloud Run service

This Cloud Run service runs Breathe London ingest in Google Cloud using the
existing `supabase/functions/ingest_breathelondon/index.ts` logic.

It keeps behavior aligned with the Edge function path:

- station/timeseries/observation ingest
- observs dual-write via shared mode (workflow default `OBSERVS_WRITE_MODE=pubsub_only`)
- Dropbox raw/log/error uploads
- connector run status updates
- `uk_aq_ingest_runs` run row insert
- `error_logs` insert on failure

## How it works

1. Service wrapper (`run_service.ts`) invokes the worker (`run_job.ts`) per POST.
2. Worker starts the BL ingest handler locally inside the container.
3. Worker builds payload from connector settings (`poll_window_hours`, `poll_timeseries_batch_size`)
   plus fresh station refs from `uk_aq_core.breathelondon_select_station_refs`.
4. Worker sends one local POST request (with `x-cron-secret` when configured).
5. Worker parses response and writes run telemetry into main DB.
6. Worker exits non-zero if ingest failed.

If no station refs are due, the run is recorded as `skipped` (`no_station_refs`)
and no local ingest call is made.

Dropbox behavior in Cloud Run:
- Log uploads are always attempted when Dropbox credentials are present.
- Raw uploads are gated by `BREATHELONDON_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (or `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`) matching `SUPABASE_URL`.
- Wrapper-inserted direct failure `error_logs` rows are mirrored into `/error_log/YYYY-MM-DD/` and patch `error_logs.dropbox_path` when Dropbox error logging is enabled.
- File prefixes are `uk_aq_log_cloud_run_*` and `uk_aq_raw_cloud_run_*`.
- Runtime budget in `ingest_breathelondon` is disabled by default in Cloud Run (`BREATHELONDON_DROPBOX_UPLOAD_SOURCE=cloud_run`).
  - Set `BREATHELONDON_ENFORCE_RUNTIME_BUDGET=true` to re-enable the edge-style cutoff.

## Build and push

```bash
PROJECT_ID="your-project-id"
REGION="europe-west2"
REPO="uk-aq"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/uk-aq-breathelondon:latest"

docker build -f workers/uk_aq_breathelondon_cloud_run/Dockerfile -t "${IMAGE}" .
docker push "${IMAGE}"
```

## Cloud Run service deploy

```bash
gcloud run deploy uk-aq-breathelondon-ingest \
  --region europe-west2 \
  --image "${IMAGE}" \
  --cpu 0.25 \
  --memory 256Mi \
  --concurrency 1 \
  --max-instances 1 \
  --min-instances 0 \
  --no-cpu-boost \
  --no-allow-unauthenticated
```

## Required env vars / secrets

- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `BREATHELONDON_API_KEY`

## Optional but recommended

- `OBSERVS_WRITE_MODE` (workflow default: `pubsub_only`)
- `GCP_OBSERVS_PUBSUB_TOPIC` (required for `OBSERVS_WRITE_MODE=pubsub_only`)
- `OBSERVS_PUBSUB_PUBLISH_BATCH_SIZE` (default `500`)
- `OBS_AQIDB_SUPABASE_URL`, `OBS_AQIDB_SECRET_KEY`, `OBS_AQIDB_RPC_SCHEMA` (required when `OBSERVS_WRITE_MODE=direct`; not injected for `pubsub_only`/`outbox_only`)
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`
- `BREATHELONDON_RAW_DROPBOX_ALLOWED_SUPABASE_URL` or `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (raw upload gate only)
- `SB_UK_AQ_CRON_SECRET`
- `BREATHELONDON_REQUEST_PAYLOAD` (JSON object overrides; dynamic connector-derived station/window/batch still apply)
- `BREATHELONDON_ENFORCE_RUNTIME_BUDGET` (optional; defaults to `false` in Cloud Run)
- `BREATHELONDON_LOCAL_PORT` (default `8000`; local ingest server port, separate from Cloud Run `PORT`)
- `BREATHELONDON_INGEST_SCRIPT_PATH` (default `/app/runtime/ingest_breathelondon/index.ts`)
