# Phase 1 Naming Contract (Hard Cut, No Legacy Fallback)

Date: 2026-03-08
Scope: `CIC-test-uk-aq-ingest`, `CIC-test-uk-aq-ops`, `CIC-test-uk-aq-schema`

## Rule
- Legacy names are removed, not aliased.
- All runtime code, SQL, workflows, and env bindings must switch atomically at cutover.
- No compatibility env vars or dual-name fallback lookups are allowed.

## Canonical Target Names

### Databases
- `ingestdb` (unchanged)
- `obs_aqidb` (replaces both `obs_aqidb` role and `aggdailydb` role)

### Schemas in `obs_aqidb`
- `uk_aq_observs` (rename from `uk_aq_history`)
- `uk_aq_aqilevels` (rename/move from `uk_aq_aggdaily`)

### Environment Variables
- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`
- `UK_AQ_OBS_AQIDB_DB_LABEL` with value `obs_aqidb`

Legacy variables to remove entirely:
- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`
- `AGGDAILY_SUPABASE_URL`
- `AGGDAILY_SECRET_KEY`
- `UK_AQ_OBS_AQIDB_DB_LABEL`
- `UK_AQ_AGGDAILY_DB_LABEL`

### R2 Naming
- Product term: `R2 History` (replace any `R2 Backup` wording)
- Prefix root: `history/v1/`
- Domain prefixes:
  - `history/v1/observations/`
  - `history/v1/aqilevels/`

Legacy path patterns to remove from logic/docs:
- `backup/observations/...`
- `_SUCCESS` completion markers under `date=YYYY-MM-DD/`

### Completion Contract
A day is complete only when day manifest is published in committed history:
- `history/v1/<domain>/day_utc=YYYY-MM-DD/manifest.json`

This completion contract must be used by:
- prune eligibility
- serving eligibility
- Dropbox backup eligibility
- validation/reconciliation jobs

## Hard-Cut Constraints
- DB/schema rename and env variable cutover must ship together.
- Website/API historical reads must not reference `uk_aq_history` after cutover.
- Worker and SQL DB-label checks must only allow `ingestdb` and `obs_aqidb`.
- Any code path that requires both `history*` and `aggdaily*` env variables must be rewritten before cutover.

## Phase 1 Output
- Full match inventory: `phase1_inventory.csv`
- Risks and blockers: `phase1_migration_risks.md`
