# OpenAQ — Gateway Recovery Playbook

Operational playbook for recovering OpenAQ ingest after an upstream outage.

See also: [openaq.md](openaq.md), [openaq_gap_logic.md](openaq_gap_logic.md), [uk_aq_openaq_cloud_run.md](uk_aq_openaq_cloud_run.md).

> **Status: not yet written.**
>
> This is a placeholder. Fill in from real incident experience when one occurs. The OpenAQ pipeline differs structurally from UK-AIR SOS (S3 archive backfill instead of live SOS gateway polling, OpenAQ v3 API for catalog + latest, no per-timeseries catalog reconciler with `catalog_missing_runs` lifecycle), so the SOS playbook does **not** transfer directly.

## What likely differs from SOS

| Aspect | SOS | OpenAQ |
|---|---|---|
| Upstream "gateway" | DEFRA SOS REST API | OpenAQ v3 API + S3 archive bucket |
| Outage type 1 | SOS gateway 5xx | OpenAQ API 5xx / rate-limit (`OPENAQ_SHARED_BUDGET_HOUR_LIMIT`) |
| Outage type 2 | (rare) catalog returns partial | S3 archive missing daily files for a window |
| Catalog reconciler with auto-end-date | Yes (`UK_AIR_TIMESERIES_END_MISSING_RUNS = 2`) | **Verify** — believed not to have one of equivalent shape |
| Recovery via reactivation SQL | Risk of reactivating orphans | **Verify** before applying SOS-style bulk SQLs |
| Backfill path | Limited (no historical archive on SOS) | Yes — `source_to_r2` from S3 archive, used by integrity job |

## Until this is written, when an OpenAQ outage happens

1. Capture which OpenAQ symptom is real:
   - 5xx / 429 from `api.openaq.org/v3` (catalog or latest endpoint)
   - 404 on `openaq-data-archive.s3.amazonaws.com/records/csv.gz/...` (S3 archive missing files for a day)
   - Both
2. Note which env was paused vs polling and for how long — this is the key clue for what state diverges
3. Check the OpenAQ adapter section of [`uk-aq-r2-history-integrity.md`](../../uk-aq-ops/system_docs/uk-aq-r2-history-integrity.md) for the integrity-job-side detection and recovery flow that already exists for OpenAQ S3 gaps
4. Compare against the SOS playbook ([`uk_air_sos_gateway_recovery.md`](uk_air_sos_gateway_recovery.md)) to copy structurally-equivalent steps where they apply (checkpoint reset, freshness verification queries)
5. Document the actual recovery here so the next person has a playbook

## Known constraints to be aware of

- The empty-manifest backfill fix (added 2026-05) means OpenAQ integrity backfills no longer fail for days where the S3 archive returns zero files — they write an empty manifest instead. See [`uk-aq-backfill-local.md → No-data tolerance`](../../uk-aq-ops/system_docs/uk-aq-backfill-local.md#no-data-tolerance).
- OpenAQ shares a per-hour rate budget across all callers in your account. Burst-recovery may need to throttle.
