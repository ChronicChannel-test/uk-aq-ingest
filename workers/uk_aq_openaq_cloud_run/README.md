# uk_aq OpenAQ Cloud Run job

This Cloud Run job runs OpenAQ ingest in Google Cloud using the existing
`supabase/functions/ingest_openaq/index.ts` logic.

## How it works

1. Checks connector state (`poll_enabled`, `scheduler_backend`) in `uk_aq_core.connectors`.
2. Claims the connector via `uk_aq_public.uk_aq_rpc_dispatch_claim`.
3. Selects due station refs using `uk_aq_public.uk_aq_rpc_openaq_select_station_refs`
   with tiered + stale limits derived from connector `batch_size`.
4. Calls local OpenAQ ingest once with scoped `station_refs`.
5. Records run status in `connectors` + `uk_aq_ingest_runs` (+ `error_logs` on failure).
6. Schedules the next run as a one-off Cloud Task at computed due time
   (fallback to a short delay when no due checkpoint is available).
7. Writes history via shared history client mode:
   - `HISTORY_WRITE_MODE=pubsub_only` publishes per-row history messages to
     Pub/Sub (direct cutover path for this worker).
   - `HISTORY_WRITE_MODE=outbox_only` keeps main DB outbox behavior.
   - `HISTORY_WRITE_MODE=direct` performs direct history RPC writes.

If no station refs are due, run is recorded as `skipped` (`no_station_refs`) and
the worker only schedules the next check task.
If station refs are selected but do not meet minimum station thresholds
(`OPENAQ_MIN_GAP_STATIONS`, default `1`; `OPENAQ_MIN_NON_GAP_STATIONS`, default
`10`), ingest returns `skipped` with `stations_polled=0`.

## Triggering model

- Primary trigger: one-off Cloud Tasks created by the worker itself.
- Safety trigger: Cloud Scheduler cron (recommended every 15 minutes) to recover
  from missed/deleted tasks and to bootstrap if task creation fails.

## Build and push

```bash
PROJECT_ID="your-project-id"
REGION="europe-west2"
REPO="uk-aq"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/uk-aq-openaq:latest"

docker build -f workers/uk_aq_openaq_cloud_run/Dockerfile -t "${IMAGE}" .
docker push "${IMAGE}"
```

## Cloud Run job update

```bash
gcloud run jobs update uk-aq-openaq-ingest \
  --region europe-west2 \
  --image "${IMAGE}" \
  --task-timeout 900s \
  --max-retries 0
```

## Required env vars / secrets

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAQ_API_KEY`

## Optional env vars

- `OPENAQ_BASE_URL` (default `https://api.openaq.org/v3`)
- `OPENAQ_CONNECTOR_CODE` (default `openaq`)
- `OPENAQ_SERVICE_REF` (default `openaq`)
- `OPENAQ_DEFAULT_WINDOW_HOURS` (default `6`)
- `OPENAQ_DEFAULT_BATCH_LIMIT` (default `56`)
- `OPENAQ_STALE_LIMIT` (default `4`)
- `OPENAQ_MIN_GAP_STATIONS` (default `1`; minimum selected gap stations needed to run regardless of non-gap count)
- `OPENAQ_MIN_NON_GAP_STATIONS` (default `10`; skip when no gap stations and non-gap selected stations are below this threshold)
- `OPENAQ_IN_FLIGHT_TIMEOUT_MINUTES` (default `30`)
- `OPENAQ_CLAIM_TIMEOUT_MINUTES` (default `30`)
- `OPENAQ_REQUEST_PAYLOAD` (JSON object overrides)
- `OPENAQ_TASKS_ENABLED` (default `true`)
- `OPENAQ_NEXT_CHECK_MIN_SECONDS` (default `60`)
- `OPENAQ_FAILURE_RETRY_SECONDS` (default `120`)
- `OPENAQ_GCP_PROJECT_ID`, `OPENAQ_GCP_REGION`
- `OPENAQ_CLOUD_RUN_JOB_NAME` (default `uk-aq-openaq-ingest`)
- `OPENAQ_TASK_QUEUE_ID` (default `uk-aq-openaq-trigger-queue`)
- `OPENAQ_TASK_INVOKER_SERVICE_ACCOUNT` (service account Cloud Tasks uses to call `jobs:run`)
- `OPENAQ_DROPBOX_UPLOAD_SOURCE` (default `cloud_run` for this worker)
- `SB_UK_AQ_CRON_SECRET` (if set, local call sends `x-cron-secret`)
- `HISTORY_SUPABASE_URL`, `HISTORY_SERVICE_ROLE_KEY`, `HISTORY_SCHEMA`
- `HISTORY_WRITE_MODE` (default in deploy workflow: `pubsub_only`)
- `HISTORY_PUBSUB_TOPIC` (required when `HISTORY_WRITE_MODE=pubsub_only`)
- `HISTORY_PUBSUB_PUBLISH_BATCH_SIZE` (optional; defaults to `500`)
- `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`
- `OPENAQ_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (or `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`)
- `UK_AQ_DROPBOX_ROOT` (default `/CIC-Test`)
