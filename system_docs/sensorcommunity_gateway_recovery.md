# Sensor.Community — Gateway Recovery Playbook

Operational playbook for recovering Sensor.Community ingest after an upstream outage.

See also: [sensorcommunity.md](sensorcommunity.md), [uk_aq_sensorcommunity_cloud_run.md](uk_aq_sensorcommunity_cloud_run.md).

> **Status: not yet written.**
>
> This is a placeholder. Fill in from real incident experience when one occurs. Sensor.Community uses an HTTP filter endpoint + a daily/monthly archive, so the failure modes and recovery levers differ from UK-AIR SOS.

## What likely differs from SOS

| Aspect | SOS | Sensor.Community |
|---|---|---|
| Upstream "gateway" | DEFRA SOS REST API | `data.sensor.community/airrohr/v1/filter/country=GB` + `archive.sensor.community/YYYY-MM-DD/` |
| Outage type 1 | SOS gateway 5xx | Filter endpoint 5xx / timeout |
| Outage type 2 | (rare) catalog returns partial | Archive day folder missing / partial |
| Catalog reconciler with auto-end-date | Yes (`UK_AIR_TIMESERIES_END_MISSING_RUNS = 2`) | **Verify** — believed not to use the same lifecycle |
| Identity model | DEFRA station IDs | Sensor IDs (community-supplied; can churn as devices come/go) |
| Backfill path | None (no historical archive) | Yes — `sensor.community` daily archive, used by integrity job |
| Rate limiting | Light | User-Agent identification required (`SCOMM_USER_AGENT`) |

The community-sensor identity model means churn is **expected** — sensors come online, go offline, get renumbered. A 24h gap for a single sensor is normal; it's only a system-level recovery scenario if many sensors stop reporting simultaneously.

## Until this is written, when a Sensor.Community outage happens

1. Confirm which Sensor.Community endpoint failed:
   - Filter endpoint (`data.sensor.community/airrohr/v1/filter/country=GB`)
   - Archive (`archive.sensor.community/YYYY-MM-DD/...`)
2. Confirm `SCOMM_USER_AGENT` is set — Sensor.Community has historically silently dropped requests without a recognisable UA
3. Note which env was paused vs polling
4. Check the Sensor.Community section of the integrity job for existing archive-reconcile tooling — see [`scripts/backup_r2/uk_aq_sensorcommunity_archive_reconcile.mjs`](../../uk-aq-ops/scripts/backup_r2/uk_aq_sensorcommunity_archive_reconcile.mjs)
5. Compare against the SOS playbook ([`uk_air_sos_gateway_recovery.md`](uk_air_sos_gateway_recovery.md)) for structurally-equivalent steps (freshness verification, post-recovery noise cleanup)
6. Document the actual recovery here

## Known constraints to be aware of

- Community sensors churn naturally — don't treat individual sensor disappearance as a system fault
- The Sensor.Community archive is on a different host (`archive.sensor.community`) from the live filter (`data.sensor.community`); an outage on one doesn't necessarily imply the other
- The archive reconcile tooling exists specifically for filling gaps from the daily archive — use it before manual SQL
