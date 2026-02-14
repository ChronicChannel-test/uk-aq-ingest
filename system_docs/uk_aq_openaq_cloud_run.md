# OpenAQ Cloud Run Scheduler

This document describes the OpenAQ Cloud Run runtime and trigger model.

## Runtime

- Worker path: `workers/uk_aq_openaq_cloud_run/run_job.ts`
- Ingest runtime path: `supabase/functions/ingest_openaq/index.ts`
- Connector code: `openaq`

The worker:
1. Verifies connector eligibility in `uk_aq_core.connectors` (`poll_enabled`, `scheduler_backend`, in-flight guard).
2. Claims the connector via `uk_aq_public.uk_aq_rpc_dispatch_claim`.
3. Loads due station refs from `uk_aq_public.uk_aq_rpc_openaq_select_station_refs`.
4. Runs OpenAQ ingest once with scoped `station_refs`.
5. Writes run summary to `connectors`, `uk_aq_ingest_runs`, and `error_logs` on failures.
6. Schedules the next run using Cloud Tasks based on earliest checkpoint due time.

Run-summary metric note:
- `uk_aq_ingest_runs.stations_updated` is populated from response station activity
  keys in this order: `stations_polled`, `stations_processed`,
  `stations_selected`, `stations_updated`, `stations`.
- `uk_aq_ingest_runs.response_payload` stores a compact subset of OpenAQ ingest
  response fields for run diagnostics (partial/stop reasons, rate-limit summary,
  request-budget stats, and selected/polled station counts).

## Trigger Model (Option 2)

- Primary trigger: self-scheduled one-off Cloud Tasks.
- Safety trigger: Cloud Scheduler cron every 15 minutes (`*/15 * * * *` by default).

Each run reads earliest `uk_aq_raw.openaq_station_checkpoints.next_due_at` and enqueues one Cloud Task that calls:

- `https://run.googleapis.com/v2/projects/<project>/locations/<region>/jobs/<job>:run`

If no due checkpoint is available, worker schedules a short fallback recheck.
When OpenAQ signals rate-limit stop/reset, the worker schedules no earlier than
the reported reset time.

## Required Config

- `GCP_OPENAQ_JOB_SERVICE_ACCOUNT` (runtime service account)
- `OPENAQ_API_KEY`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

## Recommended Config

- `GCP_OPENAQ_TASK_QUEUE_ID` (default `uk-aq-openaq-trigger-queue`)
- `GCP_OPENAQ_TASK_INVOKER_SERVICE_ACCOUNT` (defaults to job service account if unset)
- `GCP_OPENAQ_SCHEDULER_SERVICE_ACCOUNT` (defaults to job service account if unset)

## IAM Notes

- Job runtime SA needs `roles/cloudtasks.enqueuer` on the OpenAQ queue.
- Task invoker SA needs `roles/run.invoker` on the OpenAQ Cloud Run Job.
- Cloud Tasks service agent (`service-<project-number>@gcp-sa-cloudtasks.iam.gserviceaccount.com`) needs `roles/iam.serviceAccountTokenCreator` on the task invoker SA.
- Scheduler SA needs `roles/run.invoker` on the OpenAQ Cloud Run Job.
