-- PurpleAir Schema for Supabase (PostgreSQL)
-- Integrates with existing UK-AIR SOS structure

-- PurpleAir connector entry
insert into connectors (connector_code, label, service_url)
values (
  'purpleair',
  'PurpleAir Community Sensor Network',
  'https://api.purpleair.com/v1'
) on conflict (connector_code) do nothing;

-- PurpleAir Categories
insert into categories (category_ref, label, connector_id)
select v.category_ref, v.label, c.id
from (
  values
    ('purpleair_outdoor', 'Outdoor Sensor'),
    ('purpleair_indoor', 'Indoor Sensor')
) as v(category_ref, label)
join connectors c
  on c.connector_code = 'purpleair'
on conflict (connector_id, category_ref) do nothing;

-- PurpleAir Phenomena
insert into phenomena (label, connector_id)
select v.label, c.id
from (
  values
    ('PM2.5 Concentration'),
    ('PM10 Concentration'),
    ('Temperature'),
    ('Humidity'),
    ('Atmospheric Pressure')
) as v(label)
join connectors c
  on c.connector_code = 'purpleair'
on conflict do nothing;

-- PurpleAir Offerings
insert into offerings (offering_ref, label, service_ref, connector_id)
select v.offering_ref, v.label, c.connector_code, c.id
from (
  values
    ('realtime', 'Real-time Data'),
    ('historical', 'Historical Data')
) as v(offering_ref, label)
join connectors c
  on c.connector_code = 'purpleair'
on conflict (connector_id, service_ref, offering_ref) do nothing;

-- PurpleAir Procedures (sensor types)
insert into procedures (procedure_ref, label, raw_formats, service_ref, connector_id)
select v.procedure_ref, v.label, v.raw_formats, c.connector_code, c.id
from (
  values
    ('purpleair_pa2', 'PurpleAir PA-II', '{"json"}'),
    ('purpleair_flex', 'PurpleAir Flex', '{"json"}'),
    ('purpleair_zen', 'PurpleAir Zen', '{"json"}'),
    ('purpleair_touch', 'PurpleAir Touch', '{"json"}')
) as v(procedure_ref, label, raw_formats)
join connectors c
  on c.connector_code = 'purpleair'
on conflict (connector_id, service_ref, procedure_ref) do nothing;

-- PurpleAir-specific sensor metadata table
create table if not exists purpleair_sensors (
  sensor_index int primary key,
  name text,
  location_type int, -- 0=outside, 1=inside, 2=unknown
  latitude numeric,
  longitude numeric,
  altitude numeric,
  hardware text,
  firmware_version text,
  device_location_type int,
  position_rating int,
  led_brightness int,
  pm2_5_a numeric, -- Channel A PM2.5
  pm2_5_b numeric, -- Channel B PM2.5
  pm2_5_atm_a numeric, -- Channel A atmospheric PM2.5
  pm2_5_atm_b numeric, -- Channel B atmospheric PM2.5
  pm10_0_a numeric, -- Channel A PM10
  pm10_0_b numeric, -- Channel B PM10
  pm10_0_atm_a numeric, -- Channel A atmospheric PM10
  pm10_0_atm_b numeric, -- Channel B atmospheric PM10
  temperature numeric,
  humidity numeric,
  pressure numeric,
  last_seen timestamptz,
  date_created timestamptz,
  modified_at timestamptz default now(),
  geometry geography(Point, 4326) generated always as (st_point(longitude, latitude, 4326)) stored,
  connector_id bigint references connectors(id),
  created_at timestamptz default now()
);

-- Indexes for PurpleAir sensors
create index if not exists purpleair_sensors_geom_idx on purpleair_sensors using gist (geometry);
create index if not exists purpleair_sensors_location_type_idx on purpleair_sensors(location_type);
create index if not exists purpleair_sensors_last_seen_idx on purpleair_sensors(last_seen);

-- PurpleAir observations table (optimized for high-frequency data)
create table if not exists purpleair_observations (
  id bigserial primary key,
  sensor_index int references purpleair_sensors(sensor_index) on delete cascade,
  observed_at timestamptz not null,
  pm2_5_a numeric,
  pm2_5_b numeric,
  pm2_5_atm_a numeric,
  pm2_5_atm_b numeric,
  pm10_0_a numeric,
  pm10_0_b numeric,
  pm10_0_atm_a numeric,
  pm10_0_atm_b numeric,
  temperature numeric,
  humidity numeric,
  pressure numeric,
  created_at timestamptz default now()
);

-- Indexes for observations
create index if not exists purpleair_obs_sensor_time_idx on purpleair_observations(sensor_index, observed_at);
create index if not exists purpleair_obs_time_idx on purpleair_observations(observed_at);

-- PurpleAir API usage tracking
create table if not exists purpleair_api_usage (
  id bigserial primary key,
  api_call_type text not null, -- 'bounding_box', 'sensor_data', 'sensor_history'
  sensors_queried int default 0,
  points_used int not null,
  response_size_bytes int,
  api_response jsonb,
  created_at timestamptz default now()
);
create index if not exists purpleair_api_usage_created_idx on purpleair_api_usage(created_at);

-- Enable RLS on new PurpleAir tables
alter table if exists purpleair_sensors enable row level security;
alter table if exists purpleair_observations enable row level security;
alter table if exists purpleair_api_usage enable row level security;

-- RLS Policies for PurpleAir tables
do $$
declare
  t text;
begin
  for t in select unnest(array['purpleair_sensors','purpleair_observations','purpleair_api_usage'])
  loop
    -- Read policy for authenticated + service_role
    if not exists (
      select 1 from pg_policies p
      where p.schemaname = current_schema()
        and p.tablename = t
        and p.policyname = t || '_select_authenticated'
    ) then
      execute format(
        'create policy %I on %I for select using (auth.role() in (''authenticated'',''service_role''));',
        t || '_select_authenticated', t
      );
    end if;

    -- Write policy for service_role
    if not exists (
      select 1 from pg_policies p
      where p.schemaname = current_schema()
        and p.tablename = t
        and p.policyname = t || '_write_service_role'
    ) then
      execute format(
        'create policy %I on %I for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');',
        t || '_write_service_role', t
      );
    end if;
  end loop;
end $$;

-- View for latest PurpleAir readings (compatible with existing timeseries structure)
create or replace view purpleair_latest_readings as
select 
  s.sensor_index::text as station_id,
  s.name as label,
  case when s.location_type = 0 then 'outdoor' when s.location_type = 1 then 'indoor' else 'unknown' end as station_type,
  coalesce(s.connector_id, c.id) as connector_id,
  'pm25' as phenomenon_id,
  'μg/m³' as uom,
  o.observed_at,
  (s.pm2_5_a + s.pm2_5_b) / 2 as value, -- Average of both channels
  case 
    when (s.pm2_5_a + s.pm2_5_b) / 2 <= 12 then 'Good'
    when (s.pm2_5_a + s.pm2_5_b) / 2 <= 35.4 then 'Moderate'
    when (s.pm2_5_a + s.pm2_5_b) / 2 <= 55.4 then 'Unhealthy for Sensitive Groups'
    when (s.pm2_5_a + s.pm2_5_b) / 2 <= 150.4 then 'Unhealthy'
    when (s.pm2_5_a + s.pm2_5_b) / 2 <= 250.4 then 'Very Unhealthy'
    else 'Hazardous'
  end as status
from purpleair_sensors s
join lateral (
  select * from purpleair_observations o1 
  where o1.sensor_index = s.sensor_index 
  order by o1.observed_at desc 
  limit 1
) o on true
left join connectors c
  on c.connector_code = 'purpleair'
where s.location_type = 0; -- Only outdoor sensors

-- Note: Views cannot have RLS policies applied directly
-- The purpleair_latest_readings view inherits permissions from the underlying tables
-- Users will be able to access the view based on their access to purpleair_sensors and purpleair_observations
