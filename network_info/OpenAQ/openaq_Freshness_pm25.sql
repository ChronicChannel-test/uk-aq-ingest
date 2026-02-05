-- OpenAQ-only version of your freshness bucket query (PM2.5)
with openaq_connector as (
  select id, connector_code, label
  from uk_aq_core.connectors
  where connector_code = 'openaq'
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
bucketed as (
  select connector_id, 'last_value_at' as source, latest_at
  from latest_by_timeseries
  union all
  select connector_id, 'observed_at' as source, latest_at
  from latest_by_observations
),
bucketed_label as (
  select
    connector_id,
    source,
    case
      when latest_at >= now() - interval '3 hours' then '0-3 Hours'
      when latest_at >= now() - interval '6 hours' then '3-6 Hours'
      when latest_at >= now() - interval '24 hours' then '6-24 Hours'
      when latest_at >= now() - interval '7 days' then '1 - 7 Days'
      else 'Older than 7 Days'
    end as bucket
  from bucketed
)
select
  oc.connector_code,
  oc.label,
  b.source,
  count(*) as stations_with_pm25,
  count(*) filter (where b.bucket = '0-3 Hours') as stations_0_3_hours,
  count(*) filter (where b.bucket = '3-6 Hours') as stations_3_6_hours,
  count(*) filter (where b.bucket = '6-24 Hours') as stations_6_24_hours,
  count(*) filter (where b.bucket = '1 - 7 Days') as stations_1_7_days,
  count(*) filter (where b.bucket = 'Older than 7 Days') as stations_older_than_7_days
from bucketed_label b
join openaq_connector oc on oc.id = b.connector_id
group by oc.connector_code, oc.label, b.source
order by case when b.source = 'last_value_at' then 1 else 2 end;
