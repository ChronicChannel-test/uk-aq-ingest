-- Migration plan outline: native partitions/history table -> Timescale hypertable
-- This is a skeleton for planning and runbook drafting.
-- Do not run end-to-end in production without adapting object names and rehearsing.

-- 0) Pre-checks (read-only)
-- select extname, extversion from pg_extension where extname in ('timescaledb', 'pg_stat_statements');
-- select * from uk_aq_public.uk_aq_history_rpc_metrics_minute order by minute_start desc limit 100;

-- 1) Create new hypertable in target schema (example: uk_aq_history.observations_ts)
-- create table uk_aq_history.observations_ts (
--   connector_id integer not null,
--   timeseries_id integer not null,
--   observed_at timestamptz not null,
--   value double precision,
--   status text,
--   primary key (connector_id, timeseries_id, observed_at)
-- );
-- select create_hypertable('uk_aq_history.observations_ts', 'observed_at', chunk_time_interval => interval '7 days');
-- create index on uk_aq_history.observations_ts (timeseries_id, observed_at desc);
-- create index on uk_aq_history.observations_ts (observed_at desc);

-- 2) Enable compression and optional retention policies
-- alter table uk_aq_history.observations_ts
--   set (
--     timescaledb.compress,
--     timescaledb.compress_segmentby = 'connector_id,timeseries_id',
--     timescaledb.compress_orderby = 'observed_at DESC'
--   );
-- select add_compression_policy('uk_aq_history.observations_ts', compress_after => interval '30 days');
-- select add_retention_policy('uk_aq_history.observations_ts', drop_after => interval '5 years');

-- 3) Backfill in bounded windows (repeat by month/day)
-- insert into uk_aq_history.observations_ts (connector_id, timeseries_id, observed_at, value, status)
-- select connector_id, timeseries_id, observed_at, value, status
-- from uk_aq_history.observations
-- where observed_at >= '2025-01-01'::timestamptz
--   and observed_at <  '2025-02-01'::timestamptz
-- on conflict do nothing;

-- 4) Validate counts and checksums per window
-- select date_trunc('day', observed_at) as day_bucket, count(*) from uk_aq_history.observations group by 1;
-- select date_trunc('day', observed_at) as day_bucket, count(*) from uk_aq_history.observations_ts group by 1;

-- 5) Dual-write window (application/RPC writes to both old and new tables)
-- Option A: modify uk_aq_public.uk_aq_rpc_observs_observations_upsert to write both tables.
-- Option B: keep RPC writing old table and add trigger forwarding to new table.

-- 6) Read switch
-- Update read paths (RPCs/views) to use observations_ts.
-- Keep feature flag so rollback can restore old table reads quickly.

-- 7) Cutover freeze (short window)
-- lock old table writes briefly, replay tail delta, verify counts, then switch write target.

-- 8) Rollback
-- If post-cutover checks fail:
--   - revert read feature flag to old table
--   - revert write target to old table
--   - keep new hypertable for forensics and retry

-- 9) Decommission (after confidence period)
-- Drop dual-write trigger/code.
-- Archive or drop old partitions/tables in controlled batches.
