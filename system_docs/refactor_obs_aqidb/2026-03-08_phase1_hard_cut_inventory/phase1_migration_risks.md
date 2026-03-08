# Phase 1 Migration Risks (Hard Cut)

Date: 2026-03-08
Mode: no legacy fallbacks

## Inventory Summary
- Total grouped dependency entries (repo+file+token): 247
- Total raw token matches: 886

### By repo (raw matches)

ops	300
ingest	293
schema	293

### By category (raw matches)

runtime	476
docs	331
tooling_ui	59
ci_config	17
tests	3

### Top tokens (raw matches)

uk_aq_history	266
uk_aq_aggdaily	164
OBS_AQIDB_SUPABASE_URL	84
OBS_AQIDB_SECRET_KEY	73
historydb	71
AGGDAILY_SUPABASE_URL	60
aggdailydb	53
history_to_r2	42
AGGDAILY_SECRET_KEY	33
aqi-r2-test	10
backup/observations	8
UK_AQ_OBS_AQIDB_DB_LABEL	6

## Primary Risks
1. Atomic cutover risk
- Removing all legacy env names in one release can hard-fail workers/functions that are deployed out of order.
- Mitigation: orchestrate release ordering and freeze deployments during cutover window.

2. SQL/schema break risk
- Schema-qualified SQL and RPCs reference `uk_aq_history` / `uk_aq_aggdaily` extensively.
- Mitigation: land schema repo rename changes first, apply to target DB, then ship app code referencing new schemas only.

3. DB label contract break
- Multiple services enforce label allow-lists including `historydb` and `aggdailydb`.
- Mitigation: update all label checks + dashboards/metrics labels in same cut.

4. Completion contract inconsistency
- Existing maintenance logic still checks legacy `_SUCCESS`/`date=` patterns in places.
- Mitigation: unify all checks to manifest-based committed-day rule before prune/cutover.

5. Serving path regression
- Website/API historical path currently depends on history DB reads.
- Mitigation: complete R2 History reader path and date-router before removing old DB assumptions.

6. Workflow secret/config drift
- GitHub env target files and workflow docs still list old secrets.
- Mitigation: update CI/CD secret maps first; verify all jobs with dry-run validation.

## Hard-Cut Gate Criteria (must be true before rename release)
- [ ] All runtime references to removed env names are gone.
- [ ] All runtime references to removed schema names are gone.
- [ ] All runtime DB label allow-lists accept only `ingestdb` and `obs_aqidb`.
- [ ] All completion checks use manifest-published contract.
- [ ] Website/API historical reads validated against R2 History path.
- [ ] Backfill and Dropbox jobs verified against `history/v1/{observations,aqilevels}` layout.
