# UK AQ Sensor.Community Cloud Run

This document covers the Cloud Run path for Sensor.Community ingest.

## Scope

- Connector: `sensorcommunity`
- Worker: `workers/uk_aq_sensorcommunity_cloud_run`
- Scheduler: Google Cloud Scheduler -> Cloud Run Job
- Retry policy: `0` (no automatic retry)

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

## Runtime writes

Per run, worker updates:

- `uk_aq_core.connectors` (`last_run_*`, and `last_polled_at` on success)
- `uk_aq_core.uk_aq_ingest_runs` (dashboard run feed)
- `uk_aq_raw.error_logs` on ingest failure

## Deployment

See `workers/uk_aq_sensorcommunity_cloud_run/README.md` for build + deploy commands.
