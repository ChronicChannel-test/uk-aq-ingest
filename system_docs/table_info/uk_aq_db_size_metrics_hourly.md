# uk_aq_raw.db_size_metrics_hourly

Hourly database size points logged by the DB size logger Cloud Run service.

## Purpose
- Persist ingest DB, history DB, and Agg Daily DB size trends for dashboard charting.
- Keep one consolidated metrics series in ingest DB (`database_label` differentiates DBs).
- Support bounded retention cleanup without affecting observation granularity.

## Columns
- `bucket_hour` (timestamptz, PK part): UTC hour bucket for the sample.
- `database_label` (text, PK part): Database identifier (`ingestdb`, `historydb`, or `aggdailydb`).
- `database_name` (text): Postgres database name returned by `current_database()`.
- `size_bytes` (bigint): Database size in bytes from `pg_database_size(current_database())`.
- `oldest_observed_at` (timestamptz, nullable): Oldest `observed_at` currently present in that DB's observations table (null when unavailable, e.g. Agg Daily DB placeholder).
- `source` (text): Writer source tag (default `uk_aq_db_size_logger_cloud_run`).
- `recorded_at` (timestamptz): Exact sample timestamp.
- `created_at` (timestamptz): Row creation timestamp.
- `updated_at` (timestamptz): Last upsert timestamp.

## Access Pattern
- Writer RPC upsert: `uk_aq_public.uk_aq_rpc_db_size_metric_upsert`
- Writer RPC cleanup: `uk_aq_public.uk_aq_rpc_db_size_metric_cleanup`
- Reader view: `uk_aq_public.uk_aq_db_size_metrics_hourly`

## Notes
- Upsert key is `(bucket_hour, database_label)`; reruns within the same hour replace that point.
- Oldest observation tracking is captured as full datetime (`timestamptz`); dashboard legend/tooltips display day granularity as `>=DD/MM/YYYY`.
- Retention is controlled by cleanup RPC argument (`p_retention_days`, default `120`).
