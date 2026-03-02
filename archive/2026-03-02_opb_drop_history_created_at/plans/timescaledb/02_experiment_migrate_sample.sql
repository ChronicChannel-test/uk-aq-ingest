-- TimescaleDB storage assessment sample migration
-- Writes only to staging.* tables.
-- IMPORTANT: verify source schema/table names before running.
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f plans/timescaledb/02_experiment_migrate_sample.sql

begin;

-- 1) Pick one representative timeseries for the sample.
--    If you prefer station-level sampling, replace this selector query.
with candidate as (
  select
    o.connector_id,
    o.timeseries_id,
    count(*) as rows_in_last_90d
  from uk_aq_history.observations o
  where o.observed_at >= now() - interval '90 days'
  group by o.connector_id, o.timeseries_id
  having count(*) >= 1000
  order by rows_in_last_90d desc, o.connector_id, o.timeseries_id
  limit 1
)
insert into staging.timescaledb_experiment_config (
  sample_strategy,
  source_schema,
  source_table,
  sample_station_id,
  sample_timeseries_id,
  sample_days
)
select
  'single_timeseries_90_days',
  'uk_aq_history',
  'observations',
  null,
  c.timeseries_id,
  90
from candidate c;

-- 2) Reset staging sample tables for a clean rerun.
truncate table staging.obs_sample_raw;
truncate table staging.obs_sample_ts;

-- 3) Load raw sample from production history table.
insert into staging.obs_sample_raw (
  connector_id,
  timeseries_id,
  observed_at,
  value,
  status,
  created_at
)
select
  o.connector_id,
  o.timeseries_id,
  o.observed_at,
  o.value,
  o.status,
  o.created_at
from uk_aq_history.observations o
join lateral (
  select cfg.sample_timeseries_id, cfg.sample_days
  from staging.timescaledb_experiment_config cfg
  order by cfg.id desc
  limit 1
) cfg on true
where o.timeseries_id = cfg.sample_timeseries_id
  and o.observed_at >= now() - make_interval(days => cfg.sample_days)
order by o.observed_at, o.connector_id, o.timeseries_id;

-- 4) Convert staging.obs_sample_ts into a hypertable if not already converted.
select create_hypertable(
  relation => 'staging.obs_sample_ts',
  time_column_name => 'observed_at',
  chunk_time_interval => interval '7 days',
  if_not_exists => true,
  migrate_data => false
);

-- 5) Copy exactly the same sample to hypertable.
insert into staging.obs_sample_ts (
  connector_id,
  timeseries_id,
  observed_at,
  value,
  status,
  created_at
)
select
  connector_id,
  timeseries_id,
  observed_at,
  value,
  status,
  created_at
from staging.obs_sample_raw;

commit;

-- 6) Verification outputs (read-only)
select 'obs_sample_raw_rows' as metric, count(*)::bigint as value
from staging.obs_sample_raw
union all
select 'obs_sample_ts_rows' as metric, count(*)::bigint as value
from staging.obs_sample_ts;
