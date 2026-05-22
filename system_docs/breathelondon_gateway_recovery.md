# Breathe London — Gateway Recovery Playbook

Operational playbook for recovering Breathe London ingest after an upstream outage.

See also: [breathelondon.md](breathelondon.md), [uk_aq_edge_functions.md](uk_aq_edge_functions.md).

## When to use this doc

- Breathe London ingest was paused/stalled during upstream instability.
- API is now healthy, but station scheduling is not recovering as expected.
- You need a clean checkpoint restart for Breathe London only.

## Standard recovery sequence

### 1) Confirm API + key are valid

```bash
curl -fsS "https://api.breathelondon-communities.org/api/ListSensors?key=$BREATHELONDON_API_KEY" | head -c 200
```

If this is 401/403, fix credentials first. That is not a checkpoint-recovery case.

### 2) Reset Breathe London station checkpoints

NOTE: FIRST INGEST RUN OF BREATHELONDON CAN TAKE A LONG TIME. 8 MINS HAS BEEN SEEN.

```sql
begin;

-- Reset Breathe London station checkpoints so due-state is recalculated cleanly.
with bl as (
  select id from uk_aq_core.connectors where connector_code = 'breathelondon'
),
station_truth as (
  select ts.station_id, max(ts.last_value_at) as max_last_value_at
  from uk_aq_core.timeseries ts
  join bl on bl.id = ts.connector_id
  where ts.station_id is not null
  group by ts.station_id
)
update uk_aq_raw.breathelondon_station_checkpoints sc
set next_due_at        = now(),
    last_polled_at     = null,
    ingest_lag_samples = '{}'::int[],
    last_observed_at   = station_truth.max_last_value_at,
    updated_at         = now()
from station_truth
where sc.station_id = station_truth.station_id;

commit;
```

### 3) Verify due-state and freshness

```sql
select count(*) as station_due_now
from uk_aq_raw.breathelondon_station_checkpoints
where next_due_at <= now();

select
  ph.pollutant_key,
  count(*) filter (where ts.last_value_at > now() - interval '3 hours') as fresh,
  count(*) as total
from uk_aq_core.timeseries ts
join uk_aq_core.phenomena ph on ph.id = ts.phenomenon_id
join uk_aq_core.connectors c on c.id = ts.connector_id
where c.connector_code = 'breathelondon'
  and ts.ended_at is null
group by ph.pollutant_key
order by fresh desc;
```

### 4) Resume and observe

- Resume the Breathe London scheduler/worker.
- Confirm `last_polled_at` starts moving and stale rows reduce over the next runs.

## Notes vs SOS

| Aspect | SOS | Breathe London |
|---|---|---|
| Upstream "gateway" | DEFRA SOS REST API (open) | `api.breathelondon-communities.org` (API-key gated) |
| Outage type 1 | SOS gateway 5xx | API 5xx / timeout |
| Outage type 2 | (rare) catalog returns partial | `ListSensors` missing previously-listed sites |
| Outage type 3 | n/a | API key invalid/revoked/rotated (4xx storm) |
| Cadence state | station/timeseries checkpoints | station checkpoints (`uk_aq_raw.breathelondon_station_checkpoints`) |

## Known constraints

- API key rotation in Supabase secrets requires deploy/restart to guarantee runtime pickup.
- Site churn exists in the upstream feed; not every station disappearance is a system outage.
