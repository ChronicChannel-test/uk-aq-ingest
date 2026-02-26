-- Queries to capture storage findings and estimate savings
-- Run after 00/01/02/03 scripts.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f plans/timescaledb/04_findings_queries.sql

-- 1) Sizes for raw sample vs hypertable (includes indexes)
with rel as (
  select 'staging.obs_sample_raw'::regclass as oid, 'raw_sample'::text as label
  union all
  select 'staging.obs_sample_ts'::regclass as oid, 'hypertable_sample'::text as label
)
select
  label,
  pg_size_pretty(pg_total_relation_size(oid)) as total_size,
  pg_size_pretty(pg_relation_size(oid)) as table_size,
  pg_size_pretty(pg_indexes_size(oid)) as index_size,
  pg_total_relation_size(oid) as total_bytes,
  pg_relation_size(oid) as table_bytes,
  pg_indexes_size(oid) as index_bytes
from rel
order by label;

-- 2) Compression ratios with explicit arithmetic
with sizes as (
  select
    sum(case when label = 'raw_sample' then pg_total_relation_size(oid) else 0 end)::numeric as raw_total_bytes,
    sum(case when label = 'hypertable_sample' then pg_total_relation_size(oid) else 0 end)::numeric as ts_total_bytes
  from (
    select 'staging.obs_sample_raw'::regclass as oid, 'raw_sample'::text as label
    union all
    select 'staging.obs_sample_ts'::regclass as oid, 'hypertable_sample'::text as label
  ) q
)
select
  raw_total_bytes,
  ts_total_bytes,
  round(raw_total_bytes / nullif(ts_total_bytes, 0), 3) as compression_ratio_raw_over_ts,
  round((1 - (ts_total_bytes / nullif(raw_total_bytes, 0))) * 100, 2) as percent_reduction
from sizes;

-- 3) Chunk-level details (compressed/uncompressed)
select
  c.hypertable_schema,
  c.hypertable_name,
  c.chunk_schema,
  c.chunk_name,
  c.is_compressed,
  c.range_start,
  c.range_end,
  pg_size_pretty(pg_total_relation_size(format('%I.%I', c.chunk_schema, c.chunk_name)::regclass)) as chunk_total_size,
  pg_total_relation_size(format('%I.%I', c.chunk_schema, c.chunk_name)::regclass) as chunk_total_bytes
from timescaledb_information.chunks c
where c.hypertable_schema = 'staging'
  and c.hypertable_name = 'obs_sample_ts'
order by c.range_start;

-- 4) Row counts for sanity checks
select 'staging.obs_sample_raw' as table_name, count(*)::bigint as row_count from staging.obs_sample_raw
union all
select 'staging.obs_sample_ts' as table_name, count(*)::bigint as row_count from staging.obs_sample_ts;

-- 5) Annual storage projection helper.
-- Replace :annual_growth_gb with your baseline growth (8 GB/year from your note).
-- projected_timescale_gb = annual_growth_gb / compression_ratio
with params as (
  select 8.0::numeric as annual_growth_gb
), ratios as (
  select
    (select pg_total_relation_size('staging.obs_sample_raw'::regclass)::numeric) as raw_bytes,
    (select pg_total_relation_size('staging.obs_sample_ts'::regclass)::numeric) as ts_bytes
)
select
  p.annual_growth_gb,
  round((r.raw_bytes / nullif(r.ts_bytes, 0)), 3) as observed_ratio,
  round(p.annual_growth_gb / nullif((r.raw_bytes / nullif(r.ts_bytes, 0)), 0), 3) as projected_timescale_gb_per_year,
  round(p.annual_growth_gb - (p.annual_growth_gb / nullif((r.raw_bytes / nullif(r.ts_bytes, 0)), 0)), 3)
    as projected_gb_saved_per_year
from params p
cross join ratios r;
