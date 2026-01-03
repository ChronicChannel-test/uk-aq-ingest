-- Helper view + thresholds for Bristol AURN rendering

create table if not exists pollutant_thresholds (
  pollutant text,
  band int,
  label text,
  color text,
  lower_value numeric,
  upper_value numeric,
  uom text,
  primary key (pollutant, band)
);

insert into pollutant_thresholds (pollutant, band, label, color, lower_value, upper_value, uom)
values
  ('no2', 1, 'DAQI 1-3 (Low)', '#79BC6A', 0, 67, 'µg/m³'),
  ('no2', 2, 'DAQI 4-6 (Moderate)', '#BBCF4C', 68, 134, 'µg/m³'),
  ('no2', 3, 'DAQI 7-9 (High)', '#EEC20B', 135, 200, 'µg/m³'),
  ('no2', 4, 'DAQI 10 (Very High)', '#F29305', 201, null, 'µg/m³'),
  ('o3', 1, 'DAQI 1-3 (Low)', '#79BC6A', 0, 99, 'µg/m³'),
  ('o3', 2, 'DAQI 4-6 (Moderate)', '#BBCF4C', 100, 159, 'µg/m³'),
  ('o3', 3, 'DAQI 7-9 (High)', '#EEC20B', 160, 239, 'µg/m³'),
  ('o3', 4, 'DAQI 10 (Very High)', '#F29305', 240, null, 'µg/m³'),
  ('pm10', 1, 'DAQI 1-3 (Low)', '#79BC6A', 0, 16, 'µg/m³'),
  ('pm10', 2, 'DAQI 4-6 (Moderate)', '#BBCF4C', 17, 49, 'µg/m³'),
  ('pm10', 3, 'DAQI 7-9 (High)', '#EEC20B', 50, 75, 'µg/m³'),
  ('pm10', 4, 'DAQI 10 (Very High)', '#F29305', 76, null, 'µg/m³'),
  ('pm2.5', 1, 'DAQI 1-3 (Low)', '#79BC6A', 0, 11, 'µg/m³'),
  ('pm2.5', 2, 'DAQI 4-6 (Moderate)', '#BBCF4C', 12, 35, 'µg/m³'),
  ('pm2.5', 3, 'DAQI 7-9 (High)', '#EEC20B', 36, 53, 'µg/m³'),
  ('pm2.5', 4, 'DAQI 10 (Very High)', '#F29305', 54, null, 'µg/m³')
on conflict (pollutant, band) do update
set label = excluded.label,
    color = excluded.color,
    lower_value = excluded.lower_value,
    upper_value = excluded.upper_value,
    uom = excluded.uom;

create or replace view bristol_latest_pollutants as
with target_service as (
  select id
  from services
  where lower(label) like '%uk%' and lower(label) like '%air%'
  order by created_at asc
  limit 1
),
bristol_stations as (
  select stn.*
  from stations stn, target_service ts
  where stn.service_id = ts.id
    and stn.geometry && ST_MakeEnvelope(-2.75, 51.30, -2.45, 51.55, 4326)
),
latest as (
  select distinct on (obs.timeseries_id) obs.timeseries_id, obs.observed_at, obs.value, obs.status
  from observations obs
  order by obs.timeseries_id, obs.observed_at desc
)
select
  ts.id as timeseries_id,
  stn.id as station_id,
  stn.label as station_label,
  phen.id as phenomenon_id,
  phen.label as pollutant,
  ts.uom,
  latest.value as latest_value,
  latest.observed_at as observed_at,
  latest.status as status_flag,
  ts.last_value_at,
  ts.last_value,
  stn.geometry,
  coalesce(
    th.color,
    '#9ca3af'
  ) as color,
  ts.rendering_hints,
  ts.status_intervals,
  (ts.last_value_at is null or ts.last_value_at < now() - interval '3 hours') as is_stale
from timeseries ts
join bristol_stations stn
  on ts.station_id = stn.id
  and ts.service_id = stn.service_id
left join latest on latest.timeseries_id = ts.id
left join phenomena phen on phen.id = ts.phenomenon_id
left join pollutant_thresholds th
  on lower(phen.label) = th.pollutant
  and (
    (th.upper_value is null and latest.value is not null and latest.value >= th.lower_value) or
    (latest.value between th.lower_value and th.upper_value)
  );
