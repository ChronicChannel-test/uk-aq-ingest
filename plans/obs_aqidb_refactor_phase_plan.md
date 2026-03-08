# obs_aqidb Refactor Phase Plan

Last updated: 2026-03-08
Scope: cross-repo (`CIC-test-uk-aq-ingest`, `CIC-test-uk-aq-ops`, `CIC-test-uk-aq-schema`)

## Refactor Policy
- Hard cut only: no legacy fallback env vars, names, or compatibility aliases.
- Preserve rollback safety: every phase should be independently verifiable before proceeding.
- Do not remove working behavior until replacement path is implemented and validated.

## Phase Status Summary

| Phase | Name | Status | Completion Date |
| --- | --- | --- | --- |
| 0 | Repo archive / rollback safety | Complete | 2026-03-08 |
| 1 | Cross-repo inventory + naming contract freeze | Complete | 2026-03-08 |
| 2 | Hard-cut rename prep (runtime/config/workflow map) | In progress | - |
| 3 | DB/schema rename + consolidation to `obs_aqidb` | Not started | - |
| 4 | R2 History contract + manifest-complete rule unification | Not started | - |
| 5 | Retention policy refactor (configurable, default 14 days) | Not started | - |
| 6 | Website/API read-path + dashboard size charts | Not started | - |
| 7 | Dropbox incremental backup (manifest-aware daily copy) | Not started | - |
| 8 | Cutover, verification, decommission (`aggdailydb` removal) | Not started | - |
| 9 | Backfill re-engineering (post hard-cut) | Not started | - |

## Phase Details

### Phase 0: Repo archive / rollback safety
Status: Complete

Details:
- Created gitignore-aware full repository snapshots for ingest, ops, schema.
- Stored archive metadata and checksums for rollback integrity.
- Moved snapshots into each repo-local `archive/` directory for commitability.

Exit criteria met:
- All 3 repos have immutable snapshot artifacts + checksums.
- Snapshot commit SHAs recorded.

### Phase 1: Cross-repo inventory + naming contract freeze
Status: Complete

Details:
- Scanned active (non-`archive/`) files across all 3 repos for legacy DB/schema/env/R2 terms.
- Produced grouped inventory with replacement targets.
- Frozen hard-cut naming contract (legacy names must be removed, not aliased).
- Generated migration risk register with hard-cut gate checklist.

Output artifacts:
- `system_docs/refactor_obs_aqidb/2026-03-08_phase1_hard_cut_inventory/phase1_inventory.csv`
- `system_docs/refactor_obs_aqidb/2026-03-08_phase1_hard_cut_inventory/phase1_naming_contract.md`
- `system_docs/refactor_obs_aqidb/2026-03-08_phase1_hard_cut_inventory/phase1_migration_risks.md`

### Phase 2: Hard-cut rename prep (runtime/config/workflow map)
Status: In progress

Details:
- Convert Phase 1 inventory into an execution checklist by repo and deployment unit.
- Update CI/workflow/config secret names to target naming only.
- Update runtime env lookups to target names only (remove history/aggdaily env paths).
- Prepare cutover runbook with deployment ordering and freeze window.

Key outputs:
- Repo-by-repo rename checklist.
- Cutover order/runbook for functions, workers, workflows.
- Detailed execution checklist: `plans/obs_aqidb_refactor_phase2_checklist.md`

Exit criteria:
- Zero runtime references to legacy env names.
- Deployment runbook approved for atomic hard cut.

### Phase 3: DB/schema rename + consolidation to `obs_aqidb`
Status: Not started

Details:
- Create/migrate target DB state to `obs_aqidb`.
- Rename/migrate schemas:
  - `uk_aq_history` -> `uk_aq_observs`
  - `uk_aq_aggdaily` -> `uk_aq_aqilevels`
- Update SQL DDL/RPCs and schema-qualified references in schema repo first, then ingest/ops code.
- Remove any DB-label constraints that still require `obs_aqidb`/`aggdailydb`.
- Add schema-size hourly metrics storage in ingest DB for dashboarding:
  - new table for hourly schema totals for `uk_aq_observs` and `uk_aq_aqilevels` (in `obs_aqidb`),
  - include oldest day field per schema for legend rendering.

Exit criteria:
- Runtime SQL references only `uk_aq_observs` and `uk_aq_aqilevels`.
- Runtime DB label set reduced to `ingestdb` and `obs_aqidb`.
- Schema-size hourly table + read view are available for dashboard consumption.

### Phase 4: R2 History contract + manifest-complete rule unification
Status: Not started

Details:
- Rename R2 concept from "Backup" to "History" across runtime/docs/workflows.
- Finalize stable prefix layout supporting both domains now:
  - `history/v1/observations/...`
  - `history/v1/aqilevels/...`
- Enforce one completion rule everywhere:
  - complete day = manifest published in committed history.
- Remove legacy completion checks (`_SUCCESS`/loose scanning) from active logic.
- Add R2 size hourly metrics storage for dashboarding:
  - observations domain MB (`history/v1/observations/`),
  - aqilevels domain MB (`history/v1/aqilevels/`),
  - sampled hourly by scheduled job and stored in ingest DB.

Exit criteria:
- All prune/serving/backup validators use manifest-complete contract only.
- Both domains share the same completion semantics.
- R2 hourly size metrics are persisted and queryable for chart rendering.

### Phase 5: Retention policy refactor (configurable, default 14 days)
Status: Not started

Details:
- Add separate configurable retention controls for:
  - `uk_aq_observs`
  - `uk_aq_aqilevels`
- Default both to 14 days when unset.
- Keep intentional overlap: DB rolling 14 days, R2 History 7+ days old.

Exit criteria:
- Retention values configurable without code edits.
- Retention deletions gated by committed-day safety logic.

### Phase 6: Website/API read-path + dashboard size charts
Status: Not started

Details:
- Introduce date-based read routing policy (recent from DB, older from R2 History).
- Keep Cloudflare cache behavior stable and explicit for history objects.
- Ensure serving eligibility follows committed manifest rule.
- Keep existing DB cluster size line chart but hard-cut to 2 labels only:
  - `ingestdb`
  - `obs_aqidb`
- Add stacked area chart under the line chart for schema sizes in `obs_aqidb`:
  - `uk_aq_observs` MB
  - `uk_aq_aqilevels` MB
- Add stacked area chart for R2 History domain sizes:
  - observations domain MB
  - aqilevels domain MB
- Chart behaviors for both stacked area charts:
  - absolute MB (not percentage),
  - dynamic max Y-axis,
  - missing point treated as `0`.
- Legend oldest-day display for schema chart (single row, day only):
  - `uk_aq_observs >= DD/MM/YYYY   uk_aq_aqilevels >= DD/MM/YYYY`
  - AQI oldest day source is hourly AQI (`min(timestamp_hour_utc)`), not daily/monthly rollups.

Exit criteria:
- Historical reads no longer depend on removed legacy names/schemas.
- Verified serving correctness for boundary dates and overlap window.
- Dashboard renders all three size charts with new contracts and no legacy labels.

### Phase 7: Dropbox incremental backup (manifest-aware daily copy)
Status: Not started

Details:
- Implement daily R2 History -> Dropbox backup using `rclone`.
- Copy only newly completed days since last successful backup.
- Preserve mirrored R2 History layout in Dropbox.
- Add validation/report script driven by committed manifests and backup checkpoint state.

Exit criteria:
- Daily incremental copy works without re-copying full history.
- Failed runs are retry-safe and idempotent.

### Phase 8: Cutover, verification, decommission (`aggdailydb` removal)
Status: Not started

Details:
- Execute cutover runbook in controlled deployment order.
- Validate data parity, serving parity, and retention/backup behavior.
- Remove deprecated paths and references.
- Decommission `aggdailydb` after successful post-cutover validation.

Exit criteria:
- All production paths run on target naming and architecture.
- Legacy DB/schema/env/R2 naming removed from active code/workflows.
- Decommission checklist signed off.

### Phase 9: Backfill re-engineering (post hard-cut)
Status: Not started

Details:
- Re-engineer backfill service contracts and mode model around final architecture:
  - `local_to_aqilevels`
  - `obs_aqi_to_r2`
  - `source_to_all` (if retained after redesign review)
- Split/clean run orchestration, checkpoints, retries, and observability for clearer failure boundaries.
- Remove temporary/legacy assumptions from Phase 1 implementation and align with committed-day manifest rule.
- Re-validate scheduler payloads, runbook paths, metrics names, and ops dashboards after redesign.

Exit criteria:
- Backfill code path is production-ready for final naming/storage contracts.
- Retry/failure semantics are explicit, test-covered, and runbooked.
- No residual legacy naming or legacy-mode behavior in active backfill runtime paths.

## Next Phase To Execute
Recommended immediate next phase: Phase 3 (DB/schema rename + consolidation to `obs_aqidb`).

## Locked Dashboard Scope (2026-03-08)
- Keep DB line chart, but only for full DB cluster sizes: `ingestdb` and `obs_aqidb`.
- Add schema stacked area chart (MB only) for `uk_aq_observs` + `uk_aq_aqilevels`.
- Add R2 stacked area chart (MB only) for history observations domain + history aqilevels domain.
- Sampling cadence: hourly for DB, schema, and R2 size series.
- Missing datapoint handling: render as zero for stacked charts.
- Oldest day in schema legend:
  - format day only (`DD/MM/YYYY`),
  - one line containing both schema oldest days,
  - AQI oldest sourced from hourly AQI timestamps.
- Collection/storage approach:
  - extend scheduled size-metrics pipeline to write separate hourly tables for schema and R2 metrics,
  - keep existing DB-size table for DB cluster line chart.
