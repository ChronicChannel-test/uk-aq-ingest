-- uk_aq_public views (thin read-only projections)
create schema if not exists uk_aq_public;
set search_path = uk_aq_public, public;

create or replace view connectors as
select
  id,
  connector_code,
  label,
  display_name,
  service_url,
  station_display_name_template,
  overwrite_station_name,
  poll_enabled,
  poll_interval_minutes,
  poll_window_hours,
  poll_timeseries_batch_size,
  stations_bbox_supported,
  timeseries_station_filter_supported,
  last_polled_at,
  last_run_start,
  last_run_end,
  last_run_status,
  last_run_message,
  created_at
from uk_aq_core.connectors;

create or replace view categories as
select id, category_ref, label, connector_id
from uk_aq_core.categories;

create or replace view phenomena as
select id, label, eionet_uri, notation, pollutant_label, connector_id
from uk_aq_core.phenomena;

create or replace view offerings as
select id, offering_ref, label, service_ref, connector_id
from uk_aq_core.offerings;

create or replace view features as
select id, feature_ref, label, geometry, service_ref, connector_id
from uk_aq_core.features;

create or replace view procedures as
select id, procedure_ref, label, raw_formats, service_ref, connector_id
from uk_aq_core.procedures;

create or replace view stations as
select
  id,
  station_ref,
  service_ref,
  label,
  station_name,
  station_type,
  station_exposure,
  region,
  la_code,
  la_version,
  pcon_code,
  pcon_version,
  geometry,
  connector_id,
  category_id,
  first_seen_at,
  last_seen_at,
  removed_at,
  created_at
from uk_aq_core.stations;

create or replace view station_metadata as
select station_id, attributes, created_at, updated_at
from uk_aq_core.station_metadata;

create or replace view station_network_memberships as
select station_id, network_code, network_label, is_primary, created_at
from uk_aq_core.station_network_memberships;

create or replace view uk_aq_networks as
select id, network_code, display_name, connector_code, is_active, created_at
from uk_aq_core.uk_aq_networks;

create or replace view uk_air_sos_networks as
select network_ref, network_code, network_display_name, created_at, updated_at
from uk_aq_core.uk_air_sos_networks;

create or replace view uk_air_sos_network_pollutants as
select network_ref, match_type, match_value, created_at
from uk_aq_core.uk_air_sos_network_pollutants;

create or replace view uk_aq_guidelines as
select
  id,
  pollutant,
  averaging_period_label,
  averaging_period_interval,
  level_label,
  limit_value,
  uom,
  source,
  notes,
  valid_from,
  valid_to,
  created_at
from uk_aq_core.uk_aq_guidelines;

create or replace view timeseries as
select
  id,
  timeseries_ref,
  label,
  uom,
  station_id,
  service_ref,
  connector_id,
  offering_id,
  feature_id,
  procedure_id,
  phenomenon_id,
  category_id,
  first_value_at,
  last_value_at,
  last_value,
  rendering_hints,
  status_intervals,
  created_at
from uk_aq_core.timeseries;

create or replace view reference_values as
select id, timeseries_id, name, color, value, created_at
from uk_aq_core.reference_values;

create or replace view observations as
select timeseries_id, observed_at, value, status, created_at
from uk_aq_core.observations;

create or replace view uk_aq_ingest_runs as
select
  id,
  connector_id,
  connector_code,
  run_started_at,
  run_ended_at,
  run_status,
  run_message,
  last_observed_at,
  stations_updated,
  observations_upserted,
  timeseries_updated,
  series_polled,
  response_status,
  created_at
from uk_aq_core.uk_aq_ingest_runs;

create or replace view dispatcher_settings as
select id, dispatcher_parallel_ingest, max_runs_per_dispatch_call, updated_at
from uk_aq_core.dispatcher_settings;

-- Helper view + thresholds for Bristol AURN rendering
create or replace view bristol_latest_pollutants as
with target_service as (
  select id
  from uk_aq_core.connectors
  where lower(label) like '%uk%' and lower(label) like '%air%'
  order by created_at asc
  limit 1
),
bristol_stations as (
  select stn.*
  from uk_aq_core.stations stn, target_service ts
  where stn.connector_id = ts.id
    and stn.geometry && ST_MakeEnvelope(-2.75, 51.30, -2.45, 51.55, 4326)
),
latest as (
  select distinct on (obs.timeseries_id) obs.timeseries_id, obs.observed_at, obs.value, obs.status
  from uk_aq_core.observations obs
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
from uk_aq_core.timeseries ts
join bristol_stations stn
  on ts.station_id = stn.id
left join latest on latest.timeseries_id = ts.id
left join uk_aq_core.phenomena phen on phen.id = ts.phenomenon_id
left join uk_aq_core.pollutant_thresholds th
  on lower(phen.label) = th.pollutant
  and (
    (th.upper_value is null and latest.value is not null and latest.value >= th.lower_value) or
    (latest.value between th.lower_value and th.upper_value)
  );

-- Local authority latest PM2.5 (median + mean)
create or replace view uk_aq_station_lat_lon as
select
  coalesce(n.network_display_name, snm.network_label, c.display_name, c.label) as network,
  st.label as station_label,
  st.station_ref,
  concat_ws(' ', st_y(st.geometry::geometry), st_x(st.geometry::geometry)) as lat_lon
from uk_aq_core.stations st
left join uk_aq_core.station_network_memberships snm
  on snm.station_id = st.id
  and snm.is_primary is true
left join uk_aq_core.uk_air_sos_networks n
  on n.network_code = snm.network_code
left join uk_aq_core.connectors c
  on c.id = st.connector_id
where st.geometry is not null;

alter view if exists connectors set (security_invoker = true);
alter view if exists categories set (security_invoker = true);
alter view if exists phenomena set (security_invoker = true);
alter view if exists offerings set (security_invoker = true);
alter view if exists features set (security_invoker = true);
alter view if exists procedures set (security_invoker = true);
alter view if exists stations set (security_invoker = true);
alter view if exists station_metadata set (security_invoker = true);
alter view if exists station_network_memberships set (security_invoker = true);
alter view if exists uk_aq_networks set (security_invoker = true);
alter view if exists uk_air_sos_networks set (security_invoker = true);
alter view if exists uk_air_sos_network_pollutants set (security_invoker = true);
alter view if exists uk_aq_guidelines set (security_invoker = true);
alter view if exists timeseries set (security_invoker = true);
alter view if exists reference_values set (security_invoker = true);
alter view if exists observations set (security_invoker = true);
alter view if exists uk_aq_ingest_runs set (security_invoker = true);
alter view if exists dispatcher_settings set (security_invoker = true);
alter view if exists bristol_latest_pollutants set (security_invoker = true);
alter view if exists uk_aq_station_lat_lon set (security_invoker = true);

grant usage on schema uk_aq_public to authenticated, service_role;
grant select on all tables in schema uk_aq_public to authenticated, service_role;

alter default privileges in schema uk_aq_public
  grant select on tables to authenticated, service_role;
