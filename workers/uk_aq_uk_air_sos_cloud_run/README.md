# uk_aq UK-AIR SOS Cloud Run job

This Cloud Run job runs UK-AIR SOS ingest in Google Cloud using the existing
`supabase/functions/ingest_uk_air_sos/index.ts` logic.

## How it works

1. Checks connector due state in `uk_aq_core.connectors`.
2. Claims the connector via `uk_aq_public.uk_aq_rpc_dispatch_claim`.
3. Selects due SOS station refs with `uk_aq_core.uk_air_sos_select_station_refs`.
4. Resolves scoped `timeseries_ids` for those stations and invokes local SOS ingest once.
5. Records run status in `connectors` + `uk_aq_ingest_runs` (+ `error_logs` on failure).
6. Updates `uk_aq_raw.uk_air_sos_station_checkpoints` after successful/partial runs.

Run feed note:
- If the ingest response omits `last_observed_at`, the worker derives it from
  `max(timeseries.last_value_at)` across the run's selected timeseries ids.
- Station batch note:
  - By default, station batch size follows `connectors.poll_timeseries_batch_size`
    (dashboard `batch_size`) so switching backends keeps one control surface.
  - `UK_AIR_SOS_STATION_BATCH_LIMIT` is fallback-only when connector batch size is unset.
  - `batch_size` is a total cap across tier1, tier2, and stale picks (stale does not add extra rows above `batch_size`).

If no station refs are due, run is recorded as `skipped` (`no_station_refs`).
If station refs are selected but no timeseries are found, run is `skipped` (`no_timeseries_ids`).

## Edge compatibility

- Edge SOS path is unchanged and still uses
  `uk_aq_core.uk_air_sos_select_timeseries_ids` +
  `uk_aq_raw.uk_air_sos_timeseries_checkpoints`.
- Cloud Run SOS path adds station-level scheduling only for
  `scheduler_backend='google_cloud_run'`.

## Build and push

```bash
PROJECT_ID="your-project-id"
REGION="europe-west2"
REPO="uk-aq"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/uk-aq-sos:latest"

docker build -f workers/uk_aq_uk_air_sos_cloud_run/Dockerfile -t "${IMAGE}" .
docker push "${IMAGE}"
```

## Cloud Run job update

```bash
gcloud run jobs update uk-aq-sos-ingest \
  --region europe-west2 \
  --image "${IMAGE}" \
  --task-timeout 900s \
  --max-retries 0
```

## Required env vars / secrets

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Optional env vars

- `UK_AIR_SOS_BASE_URL`
- `UK_AIR_SOS_SERVICE_LABEL`
- `UK_AIR_SOS_CONNECTOR_CODE` (default `uk_air_sos`)
- `UK_AIR_SOS_DEFAULT_INTERVAL_MINUTES` (default `60`)
- `UK_AIR_SOS_IN_FLIGHT_TIMEOUT_MINUTES` (default `30`)
- `UK_AIR_SOS_CLAIM_TIMEOUT_MINUTES` (default `30`)
- `UK_AIR_SOS_DEFAULT_WINDOW_HOURS` (default `6`)
- `UK_AIR_SOS_DEFAULT_TIMESERIES_LIMIT` (default `100`)
- `UK_AIR_SOS_STATION_BATCH_LIMIT` (default `100`)
- `UK_AIR_SOS_STALE_LIMIT` (default `4`)
- `UK_AIR_SOS_MAX_RUNTIME_SECONDS` (ingest runtime budget inside handler)
- `SB_UK_AQ_CRON_SECRET` (if set, local call sends `x-cron-secret`)
- `HISTORY_SUPABASE_URL`, `HISTORY_SERVICE_ROLE_KEY`, `HISTORY_SCHEMA`
- `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`
- `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`
- `UK_AQ_DROPBOX_ROOT`, `UK_AIR_RAW_DROPBOX_FOLDER`
