# UK AQ UK-AIR SOS Cloud Run

This document covers the Cloud Run path for UK-AIR SOS ingest.

## Scope

- Connector: `uk_air_sos`
- Worker: `workers/uk_aq_uk_air_sos_cloud_run`
- Scheduler: Google Cloud Scheduler -> Cloud Run Job
- Default job name: `uk-aq-sos-ingest`

## Connector toggle

Use `connectors.scheduler_backend` in the dashboard:

- `supabase_function`: handled by `uk_aq_dispatch_polls` (edge path)
- `google_cloud_run`: handled by Cloud Run worker

## Cadence model

- Cloud Scheduler can run frequently (for example every 2 minutes).
- Effective run cadence still comes from `connectors.poll_interval_minutes`.
- The worker checks due-state and claim-state before dispatch.
- Station batch size defaults to `connectors.poll_timeseries_batch_size` (dashboard `batch_size`);
  fallback is `UK_AIR_SOS_STATION_BATCH_LIMIT` when connector batch size is unset.

## Checkpoint model

- Edge path (unchanged):
  - selector: `uk_aq_core.uk_air_sos_select_timeseries_ids`
  - checkpoint table: `uk_aq_raw.uk_air_sos_timeseries_checkpoints`
- Cloud Run path (new):
  - selector: `uk_aq_core.uk_air_sos_select_station_refs`
  - checkpoint table: `uk_aq_raw.uk_air_sos_station_checkpoints`

Cloud Run picks due stations first, then scopes timeseries to those stations.

## Run safety

- Worker claims connector via `uk_aq_public.uk_aq_rpc_dispatch_claim`.
- If claim is not acquired, the run exits without dispatch.
- In-flight guard + claim timeout prevent overlap under normal operation.

## Runtime writes

Per run, worker updates:

- `uk_aq_core.connectors` (`last_run_*`, and `last_polled_at` on success/partial)
- `uk_aq_core.uk_aq_ingest_runs` (dashboard run feed)
  - `last_observed_at` uses ingest payload when present; otherwise falls back to
    `max(timeseries.last_value_at)` across selected timeseries ids.
- `uk_aq_raw.error_logs` on ingest failure
- `uk_aq_raw.uk_air_sos_station_checkpoints` after successful/partial runs
- Dropbox artifacts use `uk_aq_*_cloud_run_*` filename prefixes
  (`UK_AIR_SOS_DROPBOX_UPLOAD_SOURCE=cloud_run`).

## Deployment

- Workflow: `.github/workflows/uk_aq_uk_air_sos_cloud_run_deploy.yml`
- Worker README: `workers/uk_aq_uk_air_sos_cloud_run/README.md`
