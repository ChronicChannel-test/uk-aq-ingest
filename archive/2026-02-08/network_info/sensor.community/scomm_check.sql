-- Sensor.Community quick checks (Supabase)

-- 1) Find the connector row
select id, connector_code, label, service_url, last_polled_at
from connectors
where connector_code = 'sensorcommunity';

-- 2) Station counts + missing geometry
with sc as (
  select id from connectors where connector_code = 'sensorcommunity'
)
select
  count(*) as total_stations,
  sum(case when geometry is null then 1 else 0 end) as missing_geometry
from stations
where connector_id in (select id from sc)
  and service_ref = 'sensorcommunity';

-- 3) Timeseries counts + latest timestamp
with sc as (
  select id from connectors where connector_code = 'sensorcommunity'
)
select
  count(*) as total_timeseries,
  max(last_value_at) as latest_value_at
from timeseries
where connector_id in (select id from sc)
  and service_ref = 'sensorcommunity';

-- 4) Observation counts + newest
with sc as (
  select id from connectors where connector_code = 'sensorcommunity'
)
select
  count(*) as total_observations,
  max(observed_at) as latest_observed_at
from observations obs
join timeseries ts on ts.id = obs.timeseries_id
where ts.connector_id in (select id from sc)
  and ts.service_ref = 'sensorcommunity';

-- 5) Latest observations sample
with sc as (
  select id from connectors where connector_code = 'sensorcommunity'
)
select ts.timeseries_ref, obs.observed_at, obs.value
from observations obs
join timeseries ts on ts.id = obs.timeseries_id
where ts.connector_id in (select id from sc)
  and ts.service_ref = 'sensorcommunity'
order by obs.observed_at desc
limit 20;
