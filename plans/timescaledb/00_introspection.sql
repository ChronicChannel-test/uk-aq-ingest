-- TimescaleDB storage assessment: read-only introspection
-- Expected runtime:
--   psql "$DATABASE_URL" -f plans/timescaledb/00_introspection.sql
-- or
--   psql "$SUPABASE_DB_URL" -f plans/timescaledb/00_introspection.sql

\echo '=== 00_introspection.sql: starting read-only introspection ==='

-- 0) Extension inventory (do not change anything)
select extname as extension_name, extversion as extension_version
from pg_extension
order by extname;

-- 1) Database size
select
  current_database() as database_name,
  pg_size_pretty(pg_database_size(current_database())) as database_size_pretty,
  pg_database_size(current_database()) as database_size_bytes;

-- 2) Top 30 relations by total size (table + indexes)
with rel_sizes as (
  select
    n.nspname as schema_name,
    c.relname as relation_name,
    c.relkind,
    pg_total_relation_size(c.oid) as total_bytes,
    pg_relation_size(c.oid) as table_bytes,
    pg_indexes_size(c.oid) as index_bytes,
    c.oid
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname not like 'pg_toast%'
    and c.relkind in ('r', 'p', 'm', 'i')
)
select
  schema_name,
  relation_name,
  relkind,
  pg_size_pretty(total_bytes) as total_size,
  pg_size_pretty(table_bytes) as table_size,
  pg_size_pretty(index_bytes) as index_size,
  total_bytes,
  table_bytes,
  index_bytes
from rel_sizes
order by total_bytes desc
limit 30;

-- 3) Candidate history observations tables
with candidates as (
  select
    n.nspname as schema_name,
    c.relname as table_name,
    c.oid,
    c.relkind
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and (
      n.nspname ilike '%history%'
      or c.relname ilike '%history%'
      or c.relname ilike '%observation%'
      or c.relname ilike '%timeseries%'
    )
)
select
  schema_name,
  table_name,
  relkind,
  pg_size_pretty(pg_total_relation_size(oid)) as total_size,
  pg_size_pretty(pg_relation_size(oid)) as table_size,
  pg_size_pretty(pg_indexes_size(oid)) as index_size,
  pg_total_relation_size(oid) as total_bytes
from candidates
order by pg_total_relation_size(oid) desc;

-- 4) Partition tree for candidate roots
with roots as (
  select
    n.nspname as schema_name,
    c.relname as table_name,
    c.oid
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'p'
    and (
      n.nspname ilike '%history%'
      or c.relname ilike '%history%'
      or c.relname ilike '%observation%'
      or c.relname ilike '%timeseries%'
    )
)
select
  r.schema_name as parent_schema,
  r.table_name as parent_table,
  c.relnamespace::regnamespace::text as child_schema,
  c.relname as child_table,
  pg_get_expr(c.relpartbound, c.oid) as partition_bound,
  pg_size_pretty(pg_total_relation_size(c.oid)) as child_total_size,
  pg_total_relation_size(c.oid) as child_total_bytes
from roots r
join pg_inherits i on i.inhparent = r.oid
join pg_class c on c.oid = i.inhrelid
order by parent_schema, parent_table, child_total_bytes desc;

-- 5) Index inventory for candidate tables
with base as (
  select
    n.nspname as schema_name,
    c.relname as table_name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and (
      n.nspname ilike '%history%'
      or c.relname ilike '%history%'
      or c.relname ilike '%observation%'
      or c.relname ilike '%timeseries%'
    )
)
select
  b.schema_name,
  b.table_name,
  i.indexname,
  i.indexdef
from base b
join pg_indexes i
  on i.schemaname = b.schema_name
 and i.tablename = b.table_name
order by b.schema_name, b.table_name, i.indexname;

-- 6) Row estimate and autovacuum stats
with base as (
  select
    n.nspname as schema_name,
    c.relname as table_name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and (
      n.nspname ilike '%history%'
      or c.relname ilike '%history%'
      or c.relname ilike '%observation%'
      or c.relname ilike '%timeseries%'
    )
)
select
  b.schema_name,
  b.table_name,
  s.n_live_tup,
  s.n_dead_tup,
  s.last_vacuum,
  s.last_autovacuum,
  s.last_analyze,
  s.last_autoanalyze,
  s.vacuum_count,
  s.autovacuum_count,
  s.analyze_count,
  s.autoanalyze_count
from base b
left join pg_stat_user_tables s
  on s.schemaname = b.schema_name
 and s.relname = b.table_name
order by coalesce(s.n_live_tup, 0) desc, b.schema_name, b.table_name;

-- 7) Column types and average width stats
with base as (
  select
    n.nspname as schema_name,
    c.relname as table_name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and (
      n.nspname ilike '%history%'
      or c.relname ilike '%history%'
      or c.relname ilike '%observation%'
      or c.relname ilike '%timeseries%'
    )
)
select
  c.table_schema,
  c.table_name,
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.is_nullable,
  s.avg_width,
  s.n_distinct
from information_schema.columns c
join base b
  on b.schema_name = c.table_schema
 and b.table_name = c.table_name
left join pg_stats s
  on s.schemaname = c.table_schema
 and s.tablename = c.table_name
 and s.attname = c.column_name
order by c.table_schema, c.table_name, c.ordinal_position;

-- 8) Timescale metadata if extension exists
select exists(select 1 from pg_extension where extname = 'timescaledb') as has_timescaledb \gset
\if :has_timescaledb
\echo 'timescaledb extension detected: listing hypertables and jobs'
select
  h.schema_name,
  h.table_name,
  h.associated_schema_name,
  h.associated_table_prefix,
  h.num_dimensions,
  h.num_chunks,
  h.compression_enabled
from timescaledb_information.hypertables h
order by h.schema_name, h.table_name;

select
  j.application_name,
  j.proc_name,
  j.schedule_interval,
  j.config,
  j.next_start,
  j.hypertable_schema,
  j.hypertable_name
from timescaledb_information.jobs j
order by j.application_name, j.hypertable_schema, j.hypertable_name;
\else
\echo 'timescaledb extension not installed in this database'
\endif

-- 9) Optional bloat analysis on one table, if pgstattuple exists
select exists(select 1 from pg_extension where extname = 'pgstattuple') as has_pgstattuple \gset
\if :has_pgstattuple
\echo 'pgstattuple extension detected; run targeted bloat checks manually if needed'
\echo 'Example: select * from pgstattuple(''uk_aq_history.observations'');'
\else
\echo 'pgstattuple extension not installed'
\endif

\echo '=== 00_introspection.sql: completed ==='
