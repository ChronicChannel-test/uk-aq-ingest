# UK AQ Sensor.Community Cloud Run

This document covers the Cloud Run path for Sensor.Community ingest.

## Scope

- Connector: `sensorcommunity`
- Worker: `workers/uk_aq_sensorcommunity_cloud_run`
- Scheduler: Google Cloud Scheduler -> Cloud Run Service
- Retry policy: Scheduler retry is `0` by default (no automatic retry)

## Connector toggle

Use `connectors.scheduler_backend` in the dashboard:

- `supabase_function`: handled by `uk_aq_dispatch_polls`
- `google_cloud_run`: handled by Cloud Run worker

Current implementation is SCOMM-only for `google_cloud_run`.

## Cadence model

- Cloud Scheduler can run frequently (for example every 2 minutes).
- Effective run cadence still comes from `connectors.poll_interval_minutes`.
- The worker checks due-state in Supabase before claiming/running.

This means cadence remains dashboard-controlled even when Cloud Scheduler frequency is fixed.

## Run safety

- Worker claims connector via `uk_aq_public.uk_aq_rpc_dispatch_claim`.
- If claim is not acquired, the run exits without dispatch.
- In-flight guard and claim timeout prevent overlap under normal operation.
- Service wrapper passes `SCOMM_TRIGGER_MODE` (`safety`, `manual`, or `task`) into worker logs.

## Runtime writes

Per run, worker updates:

- `uk_aq_core.connectors` (`last_run_*`, and `last_polled_at` on success)
- `uk_aq_core.uk_aq_ingest_runs` (dashboard run feed)
- `uk_aq_raw.error_logs` on ingest failure
- `uk_aq_raw.error_logs` warning alerts when failure-monitor thresholds are crossed:
  - consecutive server-error streak threshold (default `3`)
  - 1-hour failure-rate threshold (default `> 0.5`, with minimum-run guard)
- History dual-write rows are normalized and deduplicated by `(connector_id, timeseries_id, observed_at)` before history upsert/outbox enqueue.
- `OBSERVS_WRITE_MODE=pubsub_only` publishes history rows to GCP Pub/Sub (`GCP_OBSERVS_PUBSUB_TOPIC`) for hourly mixed-row history writer processing.
- Dropbox artifacts (when configured):
  - log JSON under `/connectors/sensorcommunity/log/YYYY-MM-DD/` with `uk_aq_log_cloud_run_*`
  - raw ZIP under `/connectors/sensorcommunity/raw_data/YYYY-MM-DD/` with `uk_aq_raw_cloud_run_*`
  - direct ingest failure `error_logs` rows mirrored under `/error_log/YYYY-MM-DD/` with `uk_aq_error_cloud_run_*`, with `error_logs.dropbox_path` patched back to the Dropbox file
  - failure-monitor alert JSON under `/error_log/YYYY-MM-DD/` with `uk_aq_error_cloud_run_*`
  - source-fetch failures include `payload.details` in the log/error payload with source URL, retries, timeout, final attempt, and HTTP status or transport error
  - if source fetch fails before any rows are returned, the raw Dropbox artifact still records the attempted source URL and fetch error details

## Deployment

See `workers/uk_aq_sensorcommunity_cloud_run/README.md` for build + deploy commands.

## Pub/Sub mode notes

- Recommended for current architecture: `SCOMM_OBSERVS_WRITE_MODE=pubsub_only` (repo variable used by deploy workflow).
- Topic variable: `GCP_OBSERVS_PUBSUB_TOPIC` (default `uk-aq-observs-observations`).
- Workflow ensures topic exists and grants Sensor.Community runtime service account `roles/pubsub.publisher` on the topic.
- Main DB history outbox should stop receiving new Sensor.Community history rows after cutover.
