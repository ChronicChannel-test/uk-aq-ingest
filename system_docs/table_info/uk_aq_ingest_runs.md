# uk_aq_ingest_runs

Stores per-run dispatcher summaries for dashboard ingest feeds.

## Fields
- id: Internal bigint primary key (generated identity).
- connector_id: Connector FK (nullable; set null if connector removed).
- connector_code: Connector code for the run.
- run_started_at: Timestamp when dispatch began.
- run_ended_at: Timestamp when dispatch finished.
- run_status: Run status (e.g. succeeded, failed, skipped).
- run_message: Dispatcher status message.
- last_observed_at: Latest timeseries last_value_at for the dispatched scope.
- stations_updated: Count of stations updated (when available).
- observations_upserted: Count of observations upserted (when available).
- timeseries_updated: Count of timeseries updated (when available).
- series_polled: Count of timeseries polled (UK-AIR SOS, OpenAQ, Breathe London when reported).
- response_status: HTTP status returned by the ingest edge function.
- response_payload: Raw response payload from the ingest edge function.
- created_at: Row creation timestamp (default now()).

## Notes
- Inserted by `uk_aq_dispatch_polls` for each attempted dispatch.
- Retention is enforced at 30 days by cleanup RPC `uk_aq_public.uk_aq_rpc_ingest_runs_cleanup`.
- Daily cleanup schedule is `pg_cron` job `uk_aq_ingest_runtime_metrics_cleanup_daily`
  via `uk_aq_ops.uk_aq_ingest_runtime_metrics_cleanup_tick(30)`.
