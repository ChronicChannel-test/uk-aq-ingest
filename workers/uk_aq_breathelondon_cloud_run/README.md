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
2. Sends one local POST request (with `x-cron-secret` when configured).
3. Parses response and writes run telemetry into main DB.
4. Exits non-zero if ingest failed.

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
  --task-timeout 900s \
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
- `BREATHELONDON_RAW_DROPBOX_ALLOWED_SUPABASE_URL` or `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`
- `SB_UK_AQ_CRON_SECRET`
