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
7. Publishes history rows using shared history mode (`HISTORY_WRITE_MODE`).

Run-summary metric note:
- `uk_aq_ingest_runs.stations_updated` is populated from response station activity
  keys in this order: `stations_polled`, `stations_processed`,
  `stations_selected`, `stations_updated`, `stations`.
- `uk_aq_ingest_runs.response_payload` stores a compact subset of OpenAQ ingest
  response fields for run diagnostics (partial/stop reasons, rate-limit summary,
  request-budget stats, and selected/polled station counts).
- `request_budget_limited` indicates local request-budget/gap-guard limiting
  (our configured per-run budget), not an OpenAQ API rate-limit stop.
- When OpenAQ ingest returns `run_status=skipped` (for example, selected
  stations do not meet `OPENAQ_MIN_GAP_STATIONS`/`OPENAQ_MIN_NON_GAP_STATIONS`
  thresholds), the worker writes `run_status` as `skipped` and preserves
  `stations_polled=0` in the run payload.

## Trigger Model (Option 2)

- Primary trigger: self-scheduled one-off Cloud Tasks.
- Safety trigger: Cloud Scheduler cron (workflow default `*/30 * * * *`).

Each run reads earliest `uk_aq_raw.openaq_station_checkpoints.next_due_at` and enqueues one Cloud Task that calls:

- `https://run.googleapis.com/v2/projects/<project>/locations/<region>/jobs/<job>:run`
- Queue reconciliation rule:
  - If an earlier/equal pending OpenAQ task exists, the worker skips enqueue.
  - If only later pending OpenAQ task(s) exist, the worker deletes those later task(s) and enqueues the newly computed earlier task.
  - If `rate_limit_reset_at` is present for the completed run, any pending OpenAQ task scheduled before that reset time is deleted and replaced with the computed post-reset task.
  - The currently executing Cloud Task (`x-cloudtasks-taskname`) is excluded from pending-task checks (supports bare task IDs and full task resource names) to avoid false `task_enqueue_skipped_existing_earlier` decisions.

Safety trigger mode:
- Scheduler invocations pass a run override env `OPENAQ_TRIGGER_MODE=safety`.
- In safety mode, the worker checks the latest OpenAQ ingest run with status
  `succeeded|success|partial|skipped`.
- If any such run exists within `OPENAQ_SAFETY_SUCCESS_LOOKBACK_MINUTES`
  (default `10`), the safety execution exits early (`safety_noop_recent_run`)
  and does not write a `uk_aq_ingest_runs` row.
- If no recent run in those statuses exists, the same execution continues as a
  normal ingest
  run (`safety_trigger_run`), and run rows are written as usual.
- Self-scheduled Cloud Tasks pass `OPENAQ_TRIGGER_MODE=task`.

If no due checkpoint is available, worker schedules a short fallback recheck.
When OpenAQ signals rate-limit stop/reset, the worker schedules no earlier than
the reported reset time.
Delay floors are outcome-aware:
- `OPENAQ_NEXT_CHECK_MIN_SECONDS` for succeeded runs.
- `OPENAQ_NEXT_CHECK_PARTIAL_MIN_SECONDS` for partial runs.
- `OPENAQ_NEXT_CHECK_SKIPPED_MIN_SECONDS` for skipped runs.

## Required Config

- `GCP_OPENAQ_JOB_SERVICE_ACCOUNT` (runtime service account)
- `OPENAQ_API_KEY`
- `SUPABASE_URL`, `SB_SECRET_KEY`

## Recommended Config

- `GCP_OPENAQ_TASK_QUEUE_ID` (default `uk-aq-openaq-trigger-queue`)
- `GCP_OPENAQ_TASK_INVOKER_SERVICE_ACCOUNT` (defaults to job service account if unset)
- `GCP_OPENAQ_SCHEDULER_SERVICE_ACCOUNT` (defaults to job service account if unset)
- `OPENAQ_MIN_GAP_STATIONS` (default `1`)
- `OPENAQ_MIN_NON_GAP_STATIONS` (default `10`)
- `OPENAQ_TIER1_RETRY_SECONDS` (default `300`; tier1 re-poll guard for station selection)
- `OPENAQ_NEXT_CHECK_MIN_SECONDS` (default `60`)
- `OPENAQ_NEXT_CHECK_PARTIAL_MIN_SECONDS` (default `60`)
- `OPENAQ_NEXT_CHECK_SKIPPED_MIN_SECONDS` (default `60`)
- `OPENAQ_INGEST_SCRIPT_PATH` (default `/app/runtime/ingest_openaq/index.ts`)
- `OPENAQ_SAFETY_SUCCESS_LOOKBACK_MINUTES` (default `10`; only used when `OPENAQ_TRIGGER_MODE=safety`; applies to recent `succeeded|success|partial|skipped` runs)
- `OPENAQ_LAG_STAT` (default `min`; options `min|median|p25` for OpenAQ lag samples)
- `OPENAQ_HISTORY_WRITE_MODE` (default in workflow: `pubsub_only`)
- `GCP_HISTORY_PUBSUB_TOPIC` (default `uk-aq-history-observations`)
- `HISTORY_PUBSUB_PUBLISH_BATCH_SIZE` (default `500`)

## IAM Notes

- Job runtime SA needs `roles/cloudtasks.enqueuer` on the OpenAQ queue.
- Job runtime SA needs `roles/cloudtasks.viewer` and `roles/cloudtasks.taskDeleter` on the OpenAQ queue for task reconciliation.
- Job runtime SA needs `roles/pubsub.publisher` on `GCP_HISTORY_PUBSUB_TOPIC` when using `HISTORY_WRITE_MODE=pubsub_only`.
- Task invoker SA needs `roles/run.invoker` on the OpenAQ Cloud Run Job.
- Cloud Tasks service agent (`service-<project-number>@gcp-sa-cloudtasks.iam.gserviceaccount.com`) needs `roles/iam.serviceAccountTokenCreator` on the task invoker SA.
- Scheduler SA needs `roles/run.invoker` on the OpenAQ Cloud Run Job.
