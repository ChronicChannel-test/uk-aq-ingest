with v_connector as (
  select id
  from uk_aq_core.connectors
  where connector_code = 'breathelondon'
  limit 1
),
latest_obs as (
  select
    t.station_id,
    max(t.last_value_at) as last_observed_at
  from uk_aq_core.timeseries t
  where t.connector_id = (select id from v_connector)
    and t.service_ref = 'breathelondon'
  group by t.station_id
),
candidates as (
  select
    stn.id as station_id,
    stn.station_ref,
    osc.station_id as checkpoint_station_id,
    osc.next_due_at,
    osc.last_observed_at,
    osc.ingest_lag_samples,
    osc.last_polled_at,
    osc.created_at,
    osc.updated_at,
    coalesce(osc.last_observed_at, lo.last_observed_at) as effective_last_observed_at,
    coalesce(osc.next_due_at, now()) as due_at
  from uk_aq_core.stations stn
  left join uk_aq_raw.breathelondon_station_checkpoints osc
    on osc.station_id = stn.id
  left join latest_obs lo
    on lo.station_id = stn.id
  where stn.connector_id = (select id from v_connector)
    and stn.service_ref = 'breathelondon'
    and stn.station_ref is not null
    and stn.removed_at is null
),
tier1 as (
  select
    c.*,
    'tier1'::text as selection_bucket,
    c.due_at as sort_at
  from candidates c
  where c.due_at <= now()
    and c.due_at >= now() - interval '3 hours'
    and (c.last_polled_at is null or c.last_polled_at <= now() - interval '5 minutes')
  order by c.last_polled_at asc nulls first,  sort_at asc 
  limit 50
),
tier2 as (
  select
    c.*,
    'tier2'::text as selection_bucket,
    c.due_at as sort_at
  from candidates c
  where c.due_at < now() - interval '3 hours'
    and c.due_at >= now() - interval '24 hours'
    and (c.last_polled_at is null or c.last_polled_at <= now() - interval '1 hour')
    and not exists (select 1 from tier1 t where t.station_id = c.station_id)
  order by sort_at asc, c.last_polled_at asc nulls first
  limit 6
),
stale as (
  select
    c.*,
    'stale'::text as selection_bucket,
    null::timestamptz as sort_at
  from candidates c
  where (c.effective_last_observed_at is null or c.effective_last_observed_at <= now() - interval '24 hours')
    and (c.last_polled_at is null or c.last_polled_at <= now() - interval '12 hours')
    and not exists (select 1 from tier1 t where t.station_id = c.station_id)
    and not exists (select 1 from tier2 t where t.station_id = c.station_id)
  order by c.effective_last_observed_at nulls first
  limit 4
),
combined as (
  select * from tier1
  union all
  select * from tier2
  union all
  select * from stale
)
select
  combined.station_id,
  combined.station_ref,
  combined.selection_bucket,
  combined.sort_at,
  combined.due_at,
  combined.effective_last_observed_at,
  combined.next_due_at,
  combined.last_observed_at,
  combined.observ_interval_samples,
  combined.ingest_lag_samples,
  combined.last_polled_at,
  combined.created_at,
  combined.updated_at
from combined
order by
  case selection_bucket
    when 'tier1' then 1
    when 'tier2' then 2
    else 3
  end,
  sort_at nulls last;
