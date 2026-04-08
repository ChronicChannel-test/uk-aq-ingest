# uk_aq_raw.observation_rpc_metrics_minute

Minute-level write-path upload metrics for observation RPC traffic in ingest DB.

## Purpose
- Track observation upsert call volume and upload payload size over time.
- Provide bounded operational telemetry without affecting observation history granularity.

## Columns
- `bucket_minute` (timestamptz, PK part): UTC minute bucket.
- `endpoint` (text, PK part): RPC endpoint label.
- `calls` (bigint): Number of calls recorded in bucket.
- `rows_input` (bigint): Total rows submitted by callers.
- `payload_bytes` (bigint): Total caller upload payload bytes (ingress/upload metric, not Supabase egress).
- `rows_upserted` (bigint): Rows reported as upserted.
- `duration_ms_sum` (bigint): Sum of RPC durations.
- `duration_ms_max` (int): Max RPC duration.

## Access Pattern
- Writer path: `uk_aq_public.uk_aq_rpc_observations_upsert` updates counters on each call.
- Reader view: `uk_aq_public.uk_aq_observation_rpc_metrics_minute`.
- Cleanup RPC: `uk_aq_public.uk_aq_rpc_observation_rpc_metrics_cleanup`.
- Scheduled cleanup: `uk_aq_ops.uk_aq_ingest_runtime_metrics_cleanup_tick`.

## Notes
- Retention is enforced at 30 days by default.
- Daily cleanup schedule is `pg_cron` job `uk_aq_ingest_runtime_metrics_cleanup_daily`
  via `uk_aq_ops.uk_aq_ingest_runtime_metrics_cleanup_tick(30)`.
