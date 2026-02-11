# uk_aq Sensor.Community Cloud Run job

This worker runs `ingest_sensorcommunity` from Google Cloud Run Jobs and honors
connector-level scheduler settings in Supabase.

## Behavior

- Reads `uk_aq_core.connectors` for `sensorcommunity`.
- Runs only when:
  - `poll_enabled = true`
  - `scheduler_backend = 'google_cloud_run'`
  - run is due based on `poll_interval_minutes` (`last_run_start`/`last_polled_at` anchor)
- Claims dispatch with `uk_aq_public.uk_aq_rpc_dispatch_claim`.
- Invokes Supabase Edge Function `ingest_sensorcommunity`.
- Writes run status back to `connectors` and inserts `uk_aq_ingest_runs` row.
- Inserts `error_logs` row on ingest failure.

This lets Cloud Scheduler run frequently (for example every 2 minutes) while
real cadence still follows the dashboard-controlled connector interval.

## Required env vars

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SB_ANON_JWT` (optional; falls back to service role key)
- `SB_UK_AQ_CRON_SECRET` (optional but recommended)
- `UK_AQ_CORE_SCHEMA` (optional; default `uk_aq_core`)
- `UK_AQ_RAW_SCHEMA` (optional; default `uk_aq_raw`)

Optional tuning:
- `SCOMM_COUNTRY` (default `GB`)
- `SCOMM_DEFAULT_INTERVAL_MINUTES` (default `15`)
- `SCOMM_IN_FLIGHT_TIMEOUT_MINUTES` (default `30`)
- `SCOMM_CLAIM_TIMEOUT_MINUTES` (default `30`)
- `SCOMM_EDGE_TIMEOUT_MS` (default `380000`)
- `SCOMM_HTTP_TIMEOUT_MS` (default `60000`)

## Build image

```bash
PROJECT_ID="your-gcp-project"
REGION="europe-west2"
REPO="uk-aq"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/uk-aq-scomm:latest"

cd workers/uk_aq_sensorcommunity_cloud_run
gcloud builds submit --tag "${IMAGE}" .
```

## Create/update Cloud Run Job

```bash
PROJECT_ID="your-gcp-project"
REGION="europe-west2"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/uk-aq/uk-aq-scomm:latest"

# Create (first time)
gcloud run jobs create uk-aq-scomm-ingest \
  --region "${REGION}" \
  --image "${IMAGE}" \
  --task-timeout 900s \
  --max-retries 0 \
  --set-env-vars "SUPABASE_URL=https://<project-ref>.supabase.co,UK_AQ_CORE_SCHEMA=uk_aq_core,UK_AQ_RAW_SCHEMA=uk_aq_raw,SCOMM_COUNTRY=GB" \
  --set-secrets "SUPABASE_SERVICE_ROLE_KEY=SUPABASE_SERVICE_ROLE_KEY:latest,SB_ANON_JWT=SB_ANON_JWT:latest,SB_UK_AQ_CRON_SECRET=SB_UK_AQ_CRON_SECRET:latest"

# Update (later)
gcloud run jobs update uk-aq-scomm-ingest \
  --region "${REGION}" \
  --image "${IMAGE}" \
  --task-timeout 900s \
  --max-retries 0
```

## Create Cloud Scheduler trigger (2 min cadence)

```bash
PROJECT_ID="your-gcp-project"
REGION="europe-west2"
SCHEDULER_SA="cloud-scheduler-invoker@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud scheduler jobs create http uk-aq-scomm-trigger \
  --location "${REGION}" \
  --schedule "*/2 * * * *" \
  --http-method POST \
  --uri "https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/uk-aq-scomm-ingest:run" \
  --oauth-service-account-email "${SCHEDULER_SA}" \
  --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform"
```

If the scheduler job already exists, use `gcloud scheduler jobs update http ...`
with the same arguments.

## Manual run

```bash
gcloud run jobs execute uk-aq-scomm-ingest --region "${REGION}" --wait
```
