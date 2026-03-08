# obs_aqidb Refactor Phase 3 Runbook

Date: 2026-03-08  
Status: ready to execute

## Purpose
Execute the hard-cut DB/schema consolidation to final names:
- `uk_aq_history` -> `uk_aq_observs`
- `uk_aq_aggdaily` -> `uk_aq_aqilevels`
- DB labels hard-cut to `ingestdb` + `obs_aqidb`
- backfill mode/column hard-cut (`local_to_aqilevels`, `rows_written_aqilevels`)

## Prerequisites
- Polling/schedulers that write observations/AQI are paused during migration.
- Phase 0 repo archives already exist in all 3 repos.
- You have DB connection strings for both clusters:
  - `SUPABASE_DB_URL` (ingestdb)
  - `OBS_AQIDB_SUPABASE_DB_URL` (obs_aqidb)

## Migration Files (schema repo)
- `schemas/migrations/2026-03-08_ingest_size_metrics_schema_r2.sql`
- `schemas/migrations/2026-03-08_ingest_drop_schema_size_metrics_store.sql`
- `schemas/migrations/2026-03-08_obs_aqidb_schema_size_metrics_store.sql`
- `schemas/migrations/2026-03-08_obs_aqidb_db_size_label_cutover.sql`
- `schemas/migrations/2026-03-08_phase3_obs_aqidb_schema_hard_cut.sql`

Schema repo absolute path:
`/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema`

## Apply Order
1. Apply obs_aqidb DB-label cutover SQL on `obs_aqidb`.
2. Apply Phase 3 hard-cut SQL on `obs_aqidb`.
3. Ensure AQI levels schema exists on `obs_aqidb` (required).
4. Apply obs schema-size metrics storage SQL on `obs_aqidb`.
5. Apply ingest size-metrics SQL on `ingestdb`.
6. Apply Phase 3 hard-cut SQL on `ingestdb`.
7. Apply ingest schema-size cleanup SQL on `ingestdb`.

Recommended commands:

```bash
SCHEMA_REPO="/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema"

psql "$OBS_AQIDB_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f "$SCHEMA_REPO/schemas/migrations/2026-03-08_obs_aqidb_db_size_label_cutover.sql"

psql "$OBS_AQIDB_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f "$SCHEMA_REPO/schemas/migrations/2026-03-08_phase3_obs_aqidb_schema_hard_cut.sql"

psql "$OBS_AQIDB_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f "$SCHEMA_REPO/schemas/aqilevels_db/uk_aq_aqilevels_schema.sql"

psql "$OBS_AQIDB_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f "$SCHEMA_REPO/schemas/migrations/2026-03-08_obs_aqidb_schema_size_metrics_store.sql"

psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f "$SCHEMA_REPO/schemas/migrations/2026-03-08_ingest_size_metrics_schema_r2.sql"

psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f "$SCHEMA_REPO/schemas/migrations/2026-03-08_phase3_obs_aqidb_schema_hard_cut.sql"

psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f "$SCHEMA_REPO/schemas/migrations/2026-03-08_ingest_drop_schema_size_metrics_store.sql"
```

## Verification SQL

### A) Verify schema rename on obs_aqidb
```sql
select nspname
from pg_namespace
where nspname in ('uk_aq_history', 'uk_aq_aggdaily', 'uk_aq_observs', 'uk_aq_aqilevels')
order by 1;
```
Expected: `uk_aq_observs` and `uk_aq_aqilevels` present; `uk_aq_history` and `uk_aq_aggdaily` absent.

### B) Verify DB label hard-cut
```sql
select database_label, count(*) as rows
from uk_aq_ops.db_size_metrics_hourly
group by 1
order by 1;
```
Expected: labels are only `ingestdb`, `obs_aqidb`.

### C) Verify backfill run-mode + column hard-cut (ingestdb)
```sql
select table_name, column_name
from information_schema.columns
where table_schema = 'uk_aq_ops'
  and table_name in ('backfill_runs', 'backfill_run_days', 'backfill_checkpoints')
  and column_name like 'rows_written_%'
order by table_name, column_name;
```
Expected: `rows_written_aqilevels` exists, no `rows_written_aggdaily`.

```sql
select 'backfill_runs' as table_name, run_mode, count(*) from uk_aq_ops.backfill_runs group by 1,2
union all
select 'backfill_run_days', run_mode, count(*) from uk_aq_ops.backfill_run_days group by 1,2
union all
select 'backfill_checkpoints', run_mode, count(*) from uk_aq_ops.backfill_checkpoints group by 1,2
union all
select 'backfill_errors', run_mode, count(*) from uk_aq_ops.backfill_errors group by 1,2
order by table_name, run_mode;
```
Expected: no `local_to_aggdaily`.

### D) Verify schema metrics objects (obs_aqidb)
```sql
select to_regclass('uk_aq_ops.schema_size_metrics_hourly') as schema_table,
       to_regclass('uk_aq_public.uk_aq_schema_size_metrics_hourly') as schema_view;
```
Expected: both are non-null.

### E) Verify schema metrics are removed from ingestdb
```sql
select to_regclass('uk_aq_ops.schema_size_metrics_hourly') as schema_table,
       to_regclass('uk_aq_public.uk_aq_schema_size_metrics_hourly') as schema_view;
```
Expected: both are null.

### F) Verify R2 metrics objects (ingestdb)
```sql
select to_regclass('uk_aq_ops.r2_domain_size_metrics_hourly') as r2_table,
       to_regclass('uk_aq_public.uk_aq_r2_domain_size_metrics_hourly') as r2_view;
```
Expected: both are non-null.

## Deploy Order After SQL
1. Deploy ops workers (DB-size logger + DB-size API worker).
2. Deploy ingest dashboard aggregator/UI.
3. Resume polling/schedulers.
4. Confirm charts:
   - DB line chart: `ingestdb`, `obs_aqidb`
   - schema stacked MB chart: `uk_aq_observs`, `uk_aq_aqilevels`
   - R2 stacked MB chart: `observations`, `aqilevels`

## Rollback (emergency only)
If Phase 3 causes blocking failures, stop writers and revert application deploy first.
For schema rename rollback only:

```sql
alter schema if exists uk_aq_observs rename to uk_aq_history;
alter schema if exists uk_aq_aqilevels rename to uk_aq_aggdaily;
```

Then re-apply previous known-good app/worker versions.
