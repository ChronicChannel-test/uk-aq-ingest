# OpenAQ — Gateway Recovery Playbook

Operational playbook for recovering OpenAQ ingest after an upstream outage.

See also: [openaq.md](openaq.md), [openaq_gap_logic.md](openaq_gap_logic.md), [uk_aq_openaq_cloud_run.md](uk_aq_openaq_cloud_run.md).

## When to use this doc

- OpenAQ polling was paused or effectively stalled during API instability.
- OpenAQ API is healthy again, but poll cadence is still skewed (stations not becoming due as expected).
- You want to force a clean station checkpoint restart without touching station/timeseries identities.

## Standard recovery sequence

### 1) Confirm upstream is back

```bash
curl -fsS "https://api.openaq.org/v3/locations?limit=1" | head -c 200
```

### 2) Reset OpenAQ station checkpoints

Run inside a transaction:

```sql
begin;

-- Reset all OpenAQ station checkpoints so dispatcher scheduling restarts cleanly.
-- next_due_at = now() makes stations eligible immediately.
-- last_observed_at is reseeded from current timeseries max(last_value_at) per station.
with openaq as (
  select id from uk_aq_core.connectors where connector_code = 'openaq'
),
station_truth as (
  select ts.station_id, max(ts.last_value_at) as max_last_value_at
  from uk_aq_core.timeseries ts
  join openaq on openaq.id = ts.connector_id
  where ts.station_id is not null
  group by ts.station_id
)
update uk_aq_raw.openaq_station_checkpoints sc
set next_due_at            = now(),
    last_polled_at         = null,
    observ_interval_samples = '{}'::int[],
    ingest_lag_samples     = '{}'::int[],
    last_observed_at       = station_truth.max_last_value_at,
    updated_at             = now()
from station_truth
where sc.station_id = station_truth.station_id;

commit;
```

Important:
- Schema should be `uk_aq_raw` (not `uk_aq_raq`).
- Your tested SQL pattern is correct; clearing `observ_interval_samples` as well avoids stale interval bias.

### 3) (Optional) Reset OpenAQ timeseries checkpoints too

Only use this when gap-mode decisions are clearly stale after long outages:

```sql
begin;

with openaq as (
  select id from uk_aq_core.connectors where connector_code = 'openaq'
),
timeseries_truth as (
  select ts.id as timeseries_id, ts.station_id, ts.last_value_at
  from uk_aq_core.timeseries ts
  join openaq on openaq.id = ts.connector_id
  where ts.station_id is not null
)
update uk_aq_raw.openaq_timeseries_checkpoints tc
set next_due_at        = now(),
    last_polled_at     = null,
    ingest_lag_samples = '{}'::int[],
    last_observed_at   = timeseries_truth.last_value_at,
    updated_at         = now()
from timeseries_truth
where tc.station_id = timeseries_truth.station_id
  and tc.timeseries_id = timeseries_truth.timeseries_id;

commit;
```

### 4) Verify due-state and freshness

```sql
select count(*) as station_due_now
from uk_aq_raw.openaq_station_checkpoints
where next_due_at <= now();

select
  ph.pollutant_key,
  count(*) filter (where ts.last_value_at > now() - interval '3 hours') as fresh,
  count(*) as total
from uk_aq_core.timeseries ts
join uk_aq_core.phenomena ph on ph.id = ts.phenomenon_id
join uk_aq_core.connectors c on c.id = ts.connector_id
where c.connector_code = 'openaq'
  and ts.ended_at is null
group by ph.pollutant_key
order by fresh desc;
```

### 5) Resume and observe

- Resume the OpenAQ deploy path/scheduler.
- Watch the next few runs for:
  - rising `last_polled_at` coverage,
  - `last_value_at` freshness recovery,
  - no repeated auth/rate-limit failures.

## Notes vs SOS

| Aspect | SOS | OpenAQ |
|---|---|---|
| Upstream "gateway" | DEFRA SOS REST API | OpenAQ v3 API + S3 archive bucket |
| Outage type 1 | SOS gateway 5xx | OpenAQ API 5xx / rate-limit (`OPENAQ_SHARED_BUDGET_HOUR_LIMIT`) |
| Outage type 2 | (rare) catalog returns partial | S3 archive missing daily files for a window |
| Catalog reconciler with auto-end-date | Yes (`UK_AIR_TIMESERIES_END_MISSING_RUNS = 2`) | No equivalent SOS-style lifecycle in current OpenAQ path |
| Recovery via reactivation SQL | Risk of reactivating orphans | Usually not needed; checkpoint reset is the primary lever |
| Backfill path | Limited (no historical archive on SOS) | Yes — `source_to_r2` from S3 archive, used by integrity job |

## Known constraints to be aware of

- The empty-manifest backfill fix (added 2026-05) means OpenAQ integrity backfills no longer fail for days where the S3 archive returns zero files — they write an empty manifest instead. See [`uk-aq-backfill-local.md → No-data tolerance`](../../uk-aq-ops/system_docs/uk-aq-backfill-local.md#no-data-tolerance).
- OpenAQ shares a per-hour rate budget across all callers in your account. Burst-recovery may need to throttle.
