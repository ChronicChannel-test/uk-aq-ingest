# obs_aqidb Refactor Phase 8 Runbook

Date: 2026-03-10  
Scope: cutover verification + decommission cleanup (`aggdailydb` removal gates)

## Goal
- Prove runtime is hard-cut to `obs_aqidb` naming/contracts.
- Remove remaining legacy `aggdailydb` operational artifacts.
- Record verification evidence before Phase 9 backfill redesign.

## Executed Steps (2026-03-10)

### 1) Live DB verification: schema + function-body legacy refs
- Checked `obs_aqidb` and `ingestdb` for:
  - schemas: `uk_aq_history`, `uk_aq_aggdaily`, `uk_aq_observs`, `uk_aq_aqilevels`
  - function definitions containing legacy refs (`uk_aq_history`, `uk_aq_aggdaily`, `aggdailydb`, `historydb`)

Result:
- `obs_aqidb`: only `uk_aq_observs` + `uk_aq_aqilevels` present.
- `obs_aqidb`: no function bodies with legacy schema/db-label terms.
- `ingestdb` (pre-fix): found 2 stale legacy references:
  - `uk_aq_public.uk_aq_rpc_history_observations_upsert(jsonb)` still present.
  - `uk_aq_aqilevels.uk_aq_aqi_index_lookup(...)` body still pointed at `uk_aq_aggdaily`.

### 2) GitHub Actions legacy variable cleanup
- Ran in ops repo:
  - `python3 scripts/uk_aq_cleanup_legacy_github_env.py --include-legacy-aggdaily-label --apply`

Result:
- Deleted legacy repo variable:
  - `UK_AQ_AGGDAILY_DB_LABEL` from `ChronicChannel-test/uk-aq-ops`.

### 3) Canonical schema migration for ingest drift
- Added migration in schema repo:
  - `schemas/migrations/2026-03-10_ingest_phase8_legacy_aggdaily_cleanup.sql`
- Added canonical guard in:
  - `schemas/ingest_db/uk_aq_rpc.sql`
  - `drop function if exists uk_aq_public.uk_aq_rpc_history_observations_upsert(jsonb);`

Migration effects:
- Drops stale legacy RPC:
  - `uk_aq_public.uk_aq_rpc_history_observations_upsert(jsonb)`
- Recreates:
  - `uk_aq_aqilevels.uk_aq_aqi_index_lookup(...)`
  - with `uk_aq_aqilevels` search path and table refs only.

### 4) Applied migration to ingestdb
- Applied:
  - `schemas/migrations/2026-03-10_ingest_phase8_legacy_aggdaily_cleanup.sql`

Post-apply verification result:
- `ingestdb`: no function bodies containing legacy schema/db-label terms.
- `to_regprocedure('uk_aq_public.uk_aq_rpc_history_observations_upsert(jsonb)')` = `absent`.

## Remaining Phase 8 Sign-off Gates
- Confirm no legacy naming remains in non-archive active docs/runbooks that are considered operator source-of-truth.
- Capture one full-day soak evidence:
  - retention jobs complete successfully,
  - R2 history backup remains green,
  - website read paths stable for 7d/31d windows.
- Approve decommission checklist closure in `plans/obs_aqidb_refactor_phase_plan.md`.

