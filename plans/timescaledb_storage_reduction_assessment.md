# TimescaleDB Storage Reduction Assessment for Supabase obs_aqidb

## Scope and safety guardrails

- This delivery starts with read-only analysis first.
- All write experiments are isolated to `staging.*` objects only.
- No production table DDL or DML is included in the experiment scripts.
- All SQL is explicit and deterministic in `plans/timescaledb/*.sql`.
- HistoryDB granularity is preserved end-to-end in this plan: no rollups, no downsampling, and no aggregation-based replacement of raw observations.

## Repo discovery summary

I reviewed the ingest repo for how history observations are written and queried.

### Key findings from repo code and docs

1. History writes flow through an RPC named `uk_aq_rpc_observs_observations_upsert`, called from shared edge code (`supabase/functions/_shared/history_client.ts`).
2. History tables live in schema `uk_aq_history`, while callable RPCs live in `uk_aq_public`.
3. Current history key shape in docs is ID-based `(connector_id, timeseries_id, observed_at)`.
4. Existing operational docs reference a separate schema repo path for history DDL:
   - `.../schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql`
   - `.../schemas/obs_aqi_db/uk_aq_obs_aqi_db_dualwrite_bootstrap.sql`

### External schema repo access note

- Attempted to clone `https://github.com/ChronicChannel-test/uk-aq-schema` from this environment.
- Network access to GitHub is blocked in this runner (`CONNECT tunnel failed, response 403`).
- As a result, this assessment provides executable introspection SQL so you can pull exact live schema and storage facts directly from your database.

## How to run the assessment

Set one connection variable, then run scripts in order.

```bash
export DATABASE_URL="postgres://..."
# or
export SUPABASE_DB_URL="postgres://..."

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f plans/timescaledb/00_introspection.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f plans/timescaledb/01_experiment_setup.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f plans/timescaledb/02_experiment_migrate_sample.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f plans/timescaledb/03_experiment_compress.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f plans/timescaledb/04_findings_queries.sql
```

## Current top disk consumers

Run:

```sql
-- from 00_introspection.sql section 2
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
select ...
from rel_sizes
order by total_bytes desc
limit 30;
```

Record your top consumers here after running:

| Rank | Schema | Relation | Kind | Total size | Table size | Index size |
|---|---|---|---|---:|---:|---:|
| 1 | TODO | TODO | TODO | TODO | TODO | TODO |
| 2 | TODO | TODO | TODO | TODO | TODO | TODO |
| ... | ... | ... | ... | ... | ... | ... |

## Current history observations schema pattern

Use these outputs from `00_introspection.sql`:

1. Candidate history observations tables and their sizes.
2. Partition tree and partition bounds.
3. Index inventory.
4. Row estimates and autovacuum stats.
5. Column datatypes and `avg_width` stats.

Fill this checklist from the query outputs:

- Main history observations table: `TODO`
- Native partitioning present: `YES/NO`
- Partition key: `TODO`
- Partition granularity (day/month/etc): `TODO`
- Primary key / unique key: `TODO`
- High-cost indexes: `TODO`
- Retention policies detected: `TODO`
- Rollup tables/materialized views/jobs detected: `TODO`

## Compression experiment design

The scripts implement a bounded and safe sample:

- Sample strategy: one representative `timeseries_id` over 90 days.
- Source: `uk_aq_history.observations`.
- Staging tables:
  - `staging.obs_sample_raw` (regular table)
  - `staging.obs_sample_ts` (hypertable)
- Compression settings:
  - `timescaledb.compress = true`
  - `timescaledb.compress_segmentby = 'connector_id,timeseries_id'`
  - `timescaledb.compress_orderby = 'observed_at DESC'`

## Experiment results (fill after execution)

Use `04_findings_queries.sql` outputs.

| Metric | Value |
|---|---:|
| Raw sample rows | TODO |
| Hypertable sample rows | TODO |
| Raw sample total bytes | TODO |
| Hypertable compressed total bytes | TODO |
| Compression ratio (raw / compressed) | TODO |
| Percent reduction | TODO |

### Annual savings estimate

Baseline from your note: at least 8 GB/year growth.

Formula:

- `projected_timescale_gb_per_year = 8 / compression_ratio`
- `projected_gb_saved_per_year = 8 - projected_timescale_gb_per_year`

Fill once ratio is known:

- Observed ratio: `TODO`
- Projected Timescale annual footprint: `TODO GB/year`
- Projected annual savings: `TODO GB/year`

Sensitivity factors to note when you interpret results:

1. Wider rows compress less efficiently.
2. High-cardinality `segmentby` columns can reduce compression gains.
3. Mutable old data weakens compression benefits and increases rewrite costs.
4. Extra secondary indexes can dominate storage even with compressed chunks.

## Compatibility notes

### Native partitions vs Timescale hypertables

- You generally migrate from native partition roots to a new hypertable table, instead of stacking both partitioning models on the same table.
- Primary/unique indexes should include the time column for performant chunk pruning and conflict handling.
- Existing RPC/query patterns that filter by `timeseries_id` + time window are a good fit for `segmentby timeseries_id` and `orderby observed_at DESC`.

### Query pattern alignment in this repo

Observed read pattern emphasizes:

- Latest and recent windows by time.
- Per-timeseries fetches (`uk_aq_timeseries_rpc`).
- Rolling latest views (`uk_aq_latest_rpc`).

This is compatible with hypertable chunk pruning and compressed historical chunks, assuming recent hot data stays uncompressed for writes.
This plan assumes chart/read paths continue to return raw observation granularity.

## Options and recommendation

### Option 1: Keep native partitioning, optimize indexes (no aggregation)

Pros:
- Lowest migration risk.
- Minimal code and operational change.
- No dependency on Timescale jobs.

Cons:
- Storage reduction usually limited compared to Timescale compression.
- More manual retention and partition maintenance.

Egress impact:
- Low direct egress impact.
- No granularity tradeoff because read shape remains raw observations.

Database-size impact:
- Low to medium reduction, mostly from index tuning and retention policy tightening.

### Option 2: Move history observations to Timescale hypertable + compression

Pros:
- Highest likely storage reduction for immutable history slices.
- Built-in chunk lifecycle and compression policies.
- Better long-horizon query performance consistency.

Cons:
- Higher migration and validation effort.
- Requires careful cutover plan for RPC writers and read paths.

Egress impact:
- Neutral to slightly positive.
- Main benefit is storage reduction, not request-count reduction.

Database-size impact:
- Medium to high reduction, dependent on measured compression ratio.

### Option 3: Hybrid (recent data hot/uncompressed, older data compressed; no rollups)

Pros:
- Good balance of write performance and storage savings.
- Limits operational risk by keeping hot window behavior similar.
- Supports gradual migration and easier rollback.

Cons:
- More policy tuning and observability needed.
- Slightly more complex runbook than Option 1.

Egress impact:
- Neutral to slightly positive from better pruning/compression behavior on older chunks, with raw granularity preserved.

Database-size impact:
- Medium to high, close to Option 2 for older data, while preserving hot-path performance.

### Recommended path

Recommend **Option 3 (Hybrid)** first, then evolve toward full Option 2 if results stay strong.

Reason:

- It captures most compression gains on cold history data.
- It limits production risk during migration.
- It keeps ingestion and recent-read behavior stable.

## Minimal-downtime migration approach

Use `plans/timescaledb/10_migration_plan_outline.sql` as the runbook skeleton.

Suggested phases:

1. Create parallel hypertable `uk_aq_history.observations_ts`.
2. Backfill in bounded time windows.
3. Validate counts/checksums by day.
4. Enable dual-write for a short burn-in.
5. Switch reads using a feature flag.
6. Perform a short write cutover window.
7. Keep rollback toggle and old table intact for confidence period.

## Rollback plan

If any validation or performance check fails:

1. Revert read paths to original table immediately via feature flag/config.
2. Revert write target to original RPC/table path.
3. Keep new hypertable untouched for forensic comparison.
4. Re-run delta reconciliation before another cutover attempt.

## Generated SQL artifacts

- `plans/timescaledb/00_introspection.sql`
- `plans/timescaledb/01_experiment_setup.sql`
- `plans/timescaledb/02_experiment_migrate_sample.sql`
- `plans/timescaledb/03_experiment_compress.sql`
- `plans/timescaledb/04_findings_queries.sql`
- `plans/timescaledb/10_migration_plan_outline.sql`
