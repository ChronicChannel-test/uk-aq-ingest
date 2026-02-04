with openaq_connector as (
  select id
  from uk_aq_core.connectors
  where connector_code = 'openaq'
  limit 1
),
pm25_series as (
  select
    ts.id,
    ts.station_id,
    ts.connector_id,
    ts.last_value,
    ts.last_value_at
  from uk_aq_core.timeseries ts
  join openaq_connector oc on oc.id = ts.connector_id
  left join uk_aq_core.phenomena p on p.id = ts.phenomenon_id
  where regexp_replace(
          lower(coalesce(p.notation, p.pollutant_label, p.label, ts.label, '')),
          '[^a-z0-9]+',
          '',
          'g'
        ) = 'pm25'
),
latest_by_timeseries as (
  select
    station_id,
    connector_id,
    max(last_value_at) as latest_at
  from pm25_series
  where last_value_at is not null
    and last_value is not null
  group by station_id, connector_id
),
latest_by_observations as (
  select
    ts.station_id,
    ts.connector_id,
    max(o.observed_at) as latest_at
  from pm25_series ts
  join uk_aq_core.observations o on o.timeseries_id = ts.id
  where o.value is not null
  group by ts.station_id, ts.connector_id
),
tier2 as (
  select station_id, connector_id, 'last_value_at'::text as source, latest_at
  from latest_by_timeseries
  where latest_at < now() - interval '6 hours'
    and latest_at >= now() - interval '24 hours'

  union all

  select station_id, connector_id, 'observed_at'::text as source, latest_at
  from latest_by_observations
  where latest_at < now() - interval '6 hours'
    and latest_at >= now() - interval '24 hours'
),
tier2_unique as (
  select
    station_id,
    max(latest_at) as latest_at,
    array_agg(distinct source order by source) as tier2_sources
  from tier2
  group by station_id
)
select
  t.tier2_sources,
  t.latest_at,

  stn.id,
  stn.station_ref,
  stn.station_name,
  stn.connector_id,
  stn.first_seen_at,
  stn.last_seen_at,
  stn.removed_at,
  stn.created_at as station_created_at,

  osc.station_id as checkpoint_station_id,
  osc.next_due_at,
  osc.last_observed_at,
  osc.observ_interval_samples,
  osc.ingest_lag_samples,
  osc.last_polled_at,
  osc.created_at as checkpoint_created_at,
  osc.updated_at as checkpoint_updated_at

from tier2_unique t
join uk_aq_core.stations stn
  on stn.id = t.station_id
left join uk_aq_raw.openaq_station_checkpoints osc
  on osc.station_id = stn.id
where stn.removed_at is null
order by t.latest_at asc, stn.id;
