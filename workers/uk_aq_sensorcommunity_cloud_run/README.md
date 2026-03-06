# uk_aq Sensor.Community Cloud Run service

This worker runs Sensor.Community ingest directly in Cloud Run Service
(without calling the Supabase Edge function).

## Behavior

- Reads `uk_aq_core.connectors` for `sensorcommunity`.
- Runs only when:
  - `poll_enabled = true`
  - `scheduler_backend = 'google_cloud_run'`
  - run is due based on `poll_interval_minutes` (`last_run_start`/`last_polled_at` anchor)
- Claims dispatch with `uk_aq_public.uk_aq_rpc_dispatch_claim`.
- Fetches Sensor.Community data directly from `data.sensor.community`.
- Upserts stations, phenomena, timeseries, and observations directly via PostgREST.
- Dual-writes observations to history DB (with main DB outbox fallback) when history env is configured.
- Supports `HISTORY_WRITE_MODE=pubsub_only` to publish history rows directly to GCP Pub/Sub.
- Normalizes and deduplicates history observation rows on `(connector_id, timeseries_id, observed_at)` before history upsert/outbox enqueue.
- Uploads run log + raw payload snapshot to Dropbox when Dropbox env/secrets are configured and allowed for the active Supabase URL.
  - Log artifact: `uk_aq_log_cloud_run_scomm_<timestamp>.json`
  - Raw artifact: `uk_aq_raw_cloud_run_scomm_<timestamp>.zip`
- Writes run status back to `connectors` and inserts `uk_aq_ingest_runs` row.
- Inserts `error_logs` row on ingest failure.

The previous proxy worker (Cloud Run -> Supabase Edge function) is archived at:
`archive/2026-02-11/workers/uk_aq_sensorcommunity_cloud_run/index.proxy_edge_invoker.mjs`

## Required env vars

- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `UK_AQ_CORE_SCHEMA` (optional; default `uk_aq_core`)
- `UK_AQ_RAW_SCHEMA` (optional; default `uk_aq_raw`)
- `HISTORY_SUPABASE_URL` (required when `HISTORY_WRITE_MODE=direct`; optional for `pubsub_only`/`outbox_only`)
- `HISTORY_SECRET_KEY` (required when `HISTORY_WRITE_MODE=direct`; not injected for `pubsub_only`/`outbox_only`)
- `HISTORY_RPC_SCHEMA` (optional; default `uk_aq_public`; used for direct mode RPC profile)
- `DROPBOX_APP_KEY` (required for Dropbox upload)
- `DROPBOX_APP_SECRET` (required for Dropbox upload)
- `DROPBOX_REFRESH_TOKEN` (required for Dropbox upload)
- `SCOMM_RAW_DROPBOX_ALLOWED_SUPABASE_URL` or `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`
  must match `SUPABASE_URL` for Dropbox upload to be enabled.

## Optional env vars (existing)

- `SCOMM_COUNTRY` (default `GB`)
- `SCOMM_BASE_URL` (default `https://data.sensor.community`)
- `SCOMM_SERVICE_REF` (default `sensorcommunity`)
- `SCOMM_USER_AGENT` (default `uk-air-quality-networks`)
- `SCOMM_INGEST_MET_FIELDS` (default `false`)
- `SCOMM_DEFAULT_INTERVAL_MINUTES` (default `15`)
- `SCOMM_IN_FLIGHT_TIMEOUT_MINUTES` (default `30`)
- `SCOMM_CLAIM_TIMEOUT_MINUTES` (default `30`)
- `SCOMM_HTTP_TIMEOUT_MS` (default `60000`)
- `SCOMM_SOURCE_TIMEOUT_MS` (default `90000`)
- `SCOMM_SOURCE_RETRIES` (default `3`)
- `SCOMM_UPSERT_CHUNK_SIZE` (default `500`)
- `SCOMM_TRIGGER_MODE` (default `manual`; set by service wrapper for observability)
- `HISTORY_UPSERT_RPC` (default `uk_aq_rpc_history_observations_upsert`)
- `HISTORY_UPSERT_CHUNK_SIZE` (default `5000`)
- `HISTORY_WRITE_MODE` (default `outbox_only`; supports `outbox_only`, `direct`, `pubsub_only`)
- `GCP_HISTORY_PUBSUB_TOPIC` (required when `HISTORY_WRITE_MODE=pubsub_only`)
- `HISTORY_PUBSUB_PUBLISH_BATCH_SIZE` (default `500`; publish chunk size when `HISTORY_WRITE_MODE=pubsub_only`)
- `SCOMM_DROPBOX_ROOT` or `UK_AQ_DROPBOX_ROOT` (default `/CIC-Test`)
- `SCOMM_RAW_DROPBOX_FOLDER` or `UK_AIR_RAW_DROPBOX_FOLDER`
  (default `/connectors/sensorcommunity/raw_data`)

## Build image

```bash
PROJECT_ID="your-gcp-project"
REGION="europe-west2"
REPO="uk-aq"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/uk-aq-scomm:latest"

cd workers/uk_aq_sensorcommunity_cloud_run
gcloud builds submit --tag "${IMAGE}" .
```

## Create/update Cloud Run Service

```bash
PROJECT_ID="your-gcp-project"
REGION="europe-west2"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/uk-aq/uk-aq-scomm:latest"

# Create or update
gcloud run deploy uk-aq-scomm-ingest \
  --region "${REGION}" \
  --image "${IMAGE}" \
  --service-account "uk-aq-scomm-job@${PROJECT_ID}.iam.gserviceaccount.com" \
  --cpu "1" \
  --memory "512Mi" \
  --timeout "600" \
  --concurrency "1" \
  --max-instances "1" \
  --min-instances "0" \
  --no-allow-unauthenticated
```

## Manual trigger

```bash
REGION="europe-west2"
SERVICE_URL="https://uk-aq-scomm-ingest-<hash>-nw.a.run.app"

TOKEN="$(gcloud auth print-identity-token)"
curl -i -X POST "${SERVICE_URL}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"trigger_mode":"manual"}'
```
