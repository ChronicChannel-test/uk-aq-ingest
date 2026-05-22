# Sensor.Community — Gateway Recovery Playbook

Operational playbook for recovering Sensor.Community ingest after an upstream outage.

See also: [sensorcommunity.md](sensorcommunity.md), [uk_aq_sensorcommunity_cloud_run.md](uk_aq_sensorcommunity_cloud_run.md).

## Key difference from OpenAQ/Breathe London

Sensor.Community Cloud Run does not use a per-station checkpoint table.  
Cadence is driven from `uk_aq_core.connectors` (`last_run_start` / `last_polled_at` + `poll_interval_minutes`).

## When to use this doc

- Sensor.Community API was unstable and ingest paused/stalled.
- API is healthy again but the connector is not running when expected.
- You need to force immediate eligibility for the next run.

## Standard recovery sequence

### 1) Confirm upstream is back

```bash
curl -fsS "https://data.sensor.community/airrohr/v1/filter/country=GB" | head -c 200
```

### 2) Reset Sensor.Community connector cadence anchors

```sql
begin;

-- Clear cadence anchors so the next run is treated as first-run due.
update uk_aq_core.connectors c
set last_polled_at  = null,
    last_run_start  = null,
    last_run_end    = null,
    last_run_status = null,
    last_run_message = null
where c.connector_code = 'sensorcommunity';

commit;
```

### 3) Verify connector due-state inputs

```sql
select
  connector_code,
  poll_enabled,
  scheduler_backend,
  poll_interval_minutes,
  last_polled_at,
  last_run_start,
  last_run_end,
  last_run_status
from uk_aq_core.connectors
where connector_code = 'sensorcommunity';
```

Expected for recovery:
- `poll_enabled = true`
- `scheduler_backend = 'google_cloud_run'` (for Cloud Run path)
- cadence anchors (`last_polled_at`, `last_run_start`) are null immediately after reset

### 4) Resume and observe

- Resume Cloud Scheduler / worker.
- Confirm connector run fields begin updating again (`last_run_start`, `last_run_end`, then `last_polled_at`).
- Confirm timeseries freshness starts recovering.

## Notes vs SOS

| Aspect | SOS | Sensor.Community |
|---|---|---|
| Upstream | DEFRA SOS REST API | `data.sensor.community/airrohr/v1/filter/country=GB` |
| Recovery lever | station checkpoint reset + catalog checks | connector cadence-anchor reset |
| Historical backfill | limited in SOS path | archive reconcile exists in ops tooling |

## Known constraints

- `SCOMM_USER_AGENT` must be set correctly for reliable upstream behavior.
- Community sensor churn is normal; evaluate outage at network level, not single-sensor level.
