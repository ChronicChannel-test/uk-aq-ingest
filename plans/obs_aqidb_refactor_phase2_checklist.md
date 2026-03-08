# obs_aqidb Refactor: Phase 2 Implementation Checklist

Last updated: 2026-03-08
Owner repo for checklist: `CIC-test-uk-aq-ingest` (execution spans ingest + ops + schema repos)
Policy: hard cut only (no legacy fallback names)
Execution status: in progress

## Scope
Phase 2 prepares and executes the hard-cut runtime/config rename and introduces the new dashboard size-metric contracts needed for:
- DB line chart (`ingestdb`, `obs_aqidb`)
- Schema stacked area chart (`uk_aq_observs`, `uk_aq_aqilevels`)
- R2 domain stacked area chart (`observations`, `aqilevels`)

## Locked Decisions (from plan)
- Oldest AQI day is from hourly AQI (`min(timestamp_hour_utc)`), not daily/monthly tables.
- Schema legend shows day only in one row:
  - `uk_aq_observs >= DD/MM/YYYY   uk_aq_aqilevels >= DD/MM/YYYY`
- Stacked charts are absolute MB, dynamic Y max, missing points rendered as `0`.
- Hourly sampling cadence.
- Separate hourly tables for schema and R2 size metrics.

## Workstream A: Schema SQL (repo: `CIC-test-uk-aq-schema`)

### A1. Rename-safe DB label contract
- [ ] Update DB size metric label checks from (`ingestdb`, `historydb`, `aggdailydb`) to (`ingestdb`, `obs_aqidb`) in canonical SQL.
- [ ] Update all related RPC argument validation and checks.

Acceptance:
- [ ] No runtime SQL in canonical schema files accepts legacy DB labels.

### A2. Add schema size hourly table + view + RPCs
- [x] Create `uk_aq_ops.schema_size_metrics_hourly` in ingest DB schema files.
- [x] Add public read view (for dashboard/API worker).
- [x] Add upsert + cleanup RPCs (service role only) matching existing DB-size metric pattern.
- [x] Store `schema_name`, `size_bytes`, `oldest_observed_at`, `bucket_hour`, `recorded_at`, `source`.

Acceptance:
- [ ] Hourly rows can be written for `uk_aq_observs` + `uk_aq_aqilevels`.
- [ ] View is readable by worker/dashboard paths.

### A3. Add R2 domain size hourly table + view + RPCs
- [x] Create `uk_aq_ops.r2_domain_size_metrics_hourly` in ingest DB schema files.
- [x] Add public read view.
- [x] Add upsert + cleanup RPCs (service role only).
- [x] Domain names fixed to `observations`, `aqilevels`.

Acceptance:
- [ ] Hourly rows can be written/read for both domains.

### A4. Keep canonical placement and docs alignment
- [x] Ensure all new/changed DDL exists in canonical schema repo files (not only worker-local SQL).
- [x] Update schema docs (`system_docs/schema-overview.md` and relevant table docs).

Acceptance:
- [ ] Schema docs match canonical SQL objects.

## Workstream B: Ops Worker/Data Collection (repo: `CIC-test-uk-aq-ops`)

### B1. DB size logger hard-cut update
- [x] Replace legacy env and labels in `uk_aq_db_size_logger_cloud_run`:
  - only `ingestdb`, `obs_aqidb`
  - remove history/aggdaily branches.
- [x] Update logger payload/log summary fields to new labels only.

Acceptance:
- [ ] Logger produces 2 DB series only.

### B2. Add schema-size sampling in scheduler path
- [x] Extend scheduled metrics job path to sample schema sizes hourly from `obs_aqidb`.
- [x] Compute schema oldest days using:
  - `uk_aq_observs`: min observation timestamp/day
  - `uk_aq_aqilevels`: min `timestamp_hour_utc`
- [x] Upsert into new schema-size hourly table.

Acceptance:
- [ ] Hourly schema metrics persist with both schemas present when data exists.

### B3. Add R2 domain-size sampling in scheduler path
- [x] Add hourly R2 size sampling for `history/v1/observations/` and `history/v1/aqilevels/`.
- [x] Upsert into new R2-size hourly table.
- [ ] Use a method that avoids full-bucket rescans where possible (manifest/index-driven preferred).

Acceptance:
- [ ] Hourly R2 size rows persist for both domains.

### B4. Expand DB-size API worker response contract
- [x] Extend `uk_aq_db_size_metrics_api_worker` response with:
  - `db_size_metrics`
  - `schema_size_metrics`
  - `r2_domain_size_metrics`
- [x] Keep response shape explicit and stable for dashboard use.

Acceptance:
- [ ] Worker returns all three metric families in one response.

## Workstream C: Ingest Data Aggregator (repo: `CIC-test-uk-aq-ingest`)

### C1. Update dashboard local fetch/normalize contract
- [x] Update label handling in `scripts/uk_aq_dashboard_local.py` to `ingestdb` + `obs_aqidb`.
- [x] Parse and pass through schema and R2 metric families from API payload.
- [x] Compute single-line oldest-day legend text:
  - `uk_aq_observs >= DD/MM/YYYY   uk_aq_aqilevels >= DD/MM/YYYY`

Acceptance:
- [ ] Aggregator JSON includes all three chart datasets + legend values.

## Workstream D: Dashboard UI (repo: `CIC-test-uk-aq-ingest`)

### D1. Keep DB line chart, hard-cut labels
- [x] Update DB line chart in `data/uk_aq_dashboard/uk_aq_dashboard.html` to render only 2 series:
  - `ingestdb`
  - `obs_aqidb`

Acceptance:
- [ ] No historydb/aggdailydb legend lines or paths remain.

### D2. Add schema stacked area chart
- [x] Add stacked area chart under DB line chart.
- [x] Plot only MB for:
  - `uk_aq_observs`
  - `uk_aq_aqilevels`
- [x] Dynamic Y max; missing values treated as `0`.
- [x] Add single-row oldest-day legend line with day-only formatting.

Acceptance:
- [ ] Chart and legend render correctly across selected periods.

### D3. Add R2 domain stacked area chart
- [x] Add stacked area chart for R2 domain sizes in MB:
  - `observations`
  - `aqilevels`
- [x] Dynamic Y max; missing values treated as `0`.

Acceptance:
- [ ] R2 chart renders with expected stacking and tooltip behavior.

## Workstream E: CI/Config/Workflow Hard Cut (ingest + ops)

### E1. Env/secret hard-cut rename
- [ ] Replace old DB env names with target names in runtime workflows/config:
  - remove `HISTORY_*`, `AGGDAILY_*`, old DB label vars
  - use `OBS_AQIDB_*` names.

Acceptance:
- [ ] No runtime workflow depends on legacy names.

### E2. Deploy order runbook
- [ ] Document and execute deployment order:
  1. Schema DDL/RPC changes
  2. Worker changes
  3. Dashboard aggregator/UI changes
  4. Final cleanup of obsolete references

Acceptance:
- [ ] Roll-forward/rollback procedure documented and tested in staging.

## Verification Checklist
- [ ] DB line chart shows only `ingestdb` + `obs_aqidb`.
- [ ] Schema stacked area chart displays both schema MB series.
- [ ] R2 stacked area chart displays both domain MB series.
- [ ] Oldest-day legend line format is exact day-only output.
- [ ] All charts handle missing series points as `0`.
- [ ] No active runtime references to legacy history/aggdaily DB names.

## Open Technical Tasks To Resolve During Implementation
- [ ] Final SQL expression for schema size bytes (table/index/toast totals) and consistency with MB conversion.
- [ ] R2 hourly size sampling strategy that minimizes Class B operations.
- [ ] Backfill policy for new schema/R2 size tables (start-now vs short backfill window).
