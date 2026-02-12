# uk_aq Breathe London Cloud Run job

This Cloud Run job runs Breathe London ingest in Google Cloud using the
existing `supabase/functions/ingest_breathelondon/index.ts` logic.

It keeps behavior aligned with the Edge function path:

- station/timeseries/observation ingest
- history dual-write with outbox fallback
- Dropbox raw/log/error uploads
- connector run status updates
- `uk_aq_ingest_runs` run row insert
- `error_logs` insert on failure

## How it works

1. Starts the BL ingest handler locally inside the container.
2. Builds payload from connector settings (`poll_window_hours`, `poll_timeseries_batch_size`)
   plus fresh station refs from `uk_aq_core.breathelondon_select_station_refs`.
3. Sends one local POST request (with `x-cron-secret` when configured).
4. Parses response and writes run telemetry into main DB.
5. Exits non-zero if ingest failed.

If no station refs are due, the run is recorded as `skipped` (`no_station_refs`)
and no local ingest call is made.

Dropbox behavior in Cloud Run:
- Log uploads are always attempted when Dropbox credentials are present.
- Raw uploads are gated by `BREATHELONDON_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (or `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`) matching `SUPABASE_URL`.
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

## Cloud Run job update

```bash
gcloud run jobs update uk-aq-breathelondon-ingest \
  --region europe-west2 \
  --image "${IMAGE}" \
  --task-timeout 600s \
  --max-retries 0
```

## Required env vars / secrets

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `BREATHELONDON_API_KEY`

## Optional but recommended

- `HISTORY_SUPABASE_URL`
- `HISTORY_SERVICE_ROLE_KEY`
- `HISTORY_SCHEMA`
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`
- `BREATHELONDON_RAW_DROPBOX_ALLOWED_SUPABASE_URL` or `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (raw upload gate only)
- `SB_UK_AQ_CRON_SECRET`
- `BREATHELONDON_REQUEST_PAYLOAD` (JSON object overrides; dynamic connector-derived station/window/batch still apply)
- `BREATHELONDON_ENFORCE_RUNTIME_BUDGET` (optional; defaults to `false` in Cloud Run)
