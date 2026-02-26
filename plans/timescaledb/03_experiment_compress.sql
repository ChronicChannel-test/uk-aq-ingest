-- TimescaleDB compression experiment on staging hypertable
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f plans/timescaledb/03_experiment_compress.sql

begin;

-- Ensure table is already a hypertable from 02_experiment_migrate_sample.sql
alter table staging.obs_sample_ts
  set (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'connector_id,timeseries_id',
    timescaledb.compress_orderby = 'observed_at DESC'
  );

-- Manually compress all chunks in the sample hypertable for deterministic result capture.
select compress_chunk(c, if_not_compressed => true)
from show_chunks('staging.obs_sample_ts') as c;

commit;

-- Optional metadata check after compression
select
  h.schema_name,
  h.table_name,
  h.num_chunks,
  h.compression_enabled
from timescaledb_information.hypertables h
where h.schema_name = 'staging'
  and h.table_name = 'obs_sample_ts';
