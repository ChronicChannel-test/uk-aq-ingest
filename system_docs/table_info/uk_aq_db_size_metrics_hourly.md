# uk_aq_ops.db_size_metrics_hourly

Hourly database size points used by the dashboard DB cluster trend charts.

## Purpose
- Persist ingest DB and Obs AQI DB size trends for dashboard charting.
- Keep one consolidated metrics series in ingest DB (`database_label` differentiates DBs).
- Support bounded retention cleanup without affecting observation granularity.

## Columns
- `bucket_hour` (timestamptz, PK part): UTC hour bucket for the sample.
- `database_label` (text, PK part): Database identifier (`ingestdb` or `obs_aqidb`).
- `database_name` (text): Postgres database name returned by `current_database()` in the source project.
- `size_bytes` (bigint): Cluster-wide database size in bytes from `sum(pg_database_size(pg_database.datname))` over `pg_database`.
- `oldest_observed_at` (timestamptz, nullable): Oldest source timestamp persisted for that DB at sample time (null when unavailable).
- `source` (text): Writer source tag (typically `uk_aq_db_size_logger_pg_cron` or `uk_aq_db_size_logger_cloud_run`).
- `recorded_at` (timestamptz): Exact sample timestamp.
- `created_at` (timestamptz): Row creation timestamp.
- `updated_at` (timestamptz): Last upsert timestamp.

## Access Pattern
- Primary local sampler: `uk_aq_ops.uk_aq_db_size_metric_sample_local`
- Fallback writer RPC upsert: `uk_aq_public.uk_aq_rpc_db_size_metric_upsert`
- Fallback writer RPC cleanup: `uk_aq_public.uk_aq_rpc_db_size_metric_cleanup`
- Reader view: `uk_aq_public.uk_aq_db_size_metrics_hourly`

## Notes
- Upsert key is `(bucket_hour, database_label)`; reruns within the same hour replace that point.
- Oldest observation tracking is captured as full datetime (`timestamptz`); dashboard legend/tooltips display day granularity as `>=DD/MM/YYYY`.
- Primary scheduling is local Supabase `pg_cron` in each DB. Cloud Run remains the fallback/manual path.
- Retention is controlled by the local sampler or cleanup RPC argument (`p_retention_days`, default `120`).
- Dashboard DB-size charts render `size_bytes` as decimal MB (`bytes / 1,000,000`).
- For ad-hoc SQL comparisons against the dashboard, use decimal MB rather than `pg_size_pretty(...)`.
