-- UK-AIR SOS / 52°North Timeseries schema for Supabase (Postgres)
-- Safe to rerun; uses IF NOT EXISTS where appropriate.

-- Ensure needed extensions
create extension if not exists postgis;
create extension if not exists pgcrypto;

-- Services (SOS instances)
create table if not exists services (
  id text primary key,
  label text not null,
  service_url text,
  version text,
  type text,
  supports_first_latest boolean,
  quantities jsonb,
  created_at timestamptz default now()
);

-- Categories
create table if not exists categories (
  id text primary key,
  label text not null,
  service_id text references services(id) on delete cascade
);

-- Phenomena
create table if not exists phenomena (
  id text primary key,
  label text not null,
  service_id text references services(id) on delete cascade
);

-- Offerings
create table if not exists offerings (
  id text primary key,
  label text not null,
  service_id text references services(id) on delete cascade
);

-- Features of interest (sites/areas)
create table if not exists features (
  id text primary key,
  label text not null,
  geometry geography(Point, 4326),
  service_id text references services(id) on delete cascade
);

-- Procedures (sensors/methods)
create table if not exists procedures (
  id text primary key,
  label text not null,
  raw_formats text[],
  service_id text references services(id) on delete cascade
);

-- Stations
create table if not exists stations (
  id text not null,
  label text not null,
  station_type text,
  region text,
  geometry geography(Point, 4326),
  service_id text not null references services(id) on delete cascade,
  category_id text references categories(id),
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz default now(),
  primary key (id, service_id)
);
create index if not exists stations_geom_idx on stations using gist (geometry);

-- Station -> phenomenon is derived via timeseries; remove legacy column if present.
alter table if exists stations drop column if exists phenomenon_id;
alter table if exists stations add column if not exists first_seen_at timestamptz default now();
alter table if exists stations add column if not exists last_seen_at timestamptz;
alter table if exists stations add column if not exists removed_at timestamptz;
alter table if exists stations alter column service_id set not null;

-- Timeseries metadata
create table if not exists timeseries (
  id text primary key,
  label text not null,
  uom text,
  station_id text,
  service_id text references services(id) on delete cascade,
  offering_id text references offerings(id),
  feature_id text references features(id),
  procedure_id text references procedures(id),
  phenomenon_id text references phenomena(id),
  category_id text references categories(id),
  first_value_at timestamptz,
  last_value_at timestamptz,
  last_value numeric,
  extras jsonb,
  rendering_hints jsonb,
  status_intervals jsonb,
  created_at timestamptz default now(),
  constraint timeseries_station_service_fkey
    foreign key (station_id, service_id)
    references stations(id, service_id)
    on delete cascade
);
create index if not exists timeseries_station_idx on timeseries(station_id);
create index if not exists timeseries_phenomenon_idx on timeseries(phenomenon_id);
create index if not exists timeseries_phenomenon_station_idx on timeseries(phenomenon_id, station_id);

alter table if exists timeseries drop constraint if exists timeseries_station_id_fkey;
alter table if exists timeseries drop constraint if exists timeseries_station_service_fkey;

-- Composite key migration (stations + timeseries)
alter table if exists stations drop constraint if exists stations_pkey;
alter table if exists stations add constraint stations_pkey primary key (id, service_id);
alter table if exists timeseries add constraint timeseries_station_service_fkey
  foreign key (station_id, service_id)
  references stations(id, service_id)
  on delete cascade;

-- Reference values attached to a timeseries
create table if not exists reference_values (
  id uuid default gen_random_uuid() primary key,
  timeseries_id text references timeseries(id) on delete cascade,
  name text,
  color text,
  value numeric,
  created_at timestamptz default now()
);

-- Observations (time-value pairs)
create table if not exists observations (
  id bigserial primary key,
  timeseries_id text references timeseries(id) on delete cascade,
  observed_at timestamptz not null,
  value numeric,
  status text,
  created_at timestamptz default now()
);
create index if not exists observations_ts_time_idx on observations(timeseries_id, observed_at);
create index if not exists observations_time_idx on observations(observed_at);

-- PM2.5 Population Exposure Indicator progress (PERT)
create table if not exists pm25_population_exposure (
  year int primary key,
  pei_base numeric,
  pei numeric,
  yearly_change numeric,
  cumulative_change numeric,
  cumulative_change_pct numeric,
  collected_at timestamptz default now()
);

-- PM2.5 Annual Mean Concentration Target stats (AMCT)
create table if not exists pm25_amct_sites (
  id uuid default gen_random_uuid() primary key,
  site_code text,
  site_name text,
  year int,
  annual_mean numeric,
  exceeded_interim boolean,
  exceeded_final boolean,
  data_capture_ok boolean,
  collected_at timestamptz default now()
);
create index if not exists pm25_amct_site_year_idx on pm25_amct_sites(site_code, year);

-- ----------------------------
-- Row Level Security (RLS)
-- ----------------------------
-- Enable RLS on all tables and add safe-to-reapply policies:
--   - authenticated + service_role: read
--   - service_role: write
-- Assumes Supabase roles where auth.role() is available.

-- Enable RLS
alter table if exists services enable row level security;
alter table if exists categories enable row level security;
alter table if exists phenomena enable row level security;
alter table if exists offerings enable row level security;
alter table if exists features enable row level security;
alter table if exists procedures enable row level security;
alter table if exists stations enable row level security;
alter table if exists timeseries enable row level security;
alter table if exists reference_values enable row level security;
alter table if exists observations enable row level security;
alter table if exists pm25_population_exposure enable row level security;
alter table if exists pm25_amct_sites enable row level security;

-- Helper DO block to add policies idempotently
do $$
declare
  t text;
begin
  for t in select unnest(array[
    'services','categories','phenomena','offerings','features','procedures','stations','timeseries','reference_values','observations','pm25_population_exposure','pm25_amct_sites'
  ])
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

-- PostGIS system table: enable RLS if we own it; otherwise skip.
do $$
declare
  owner_name text;
begin
  select r.rolname into owner_name
  from pg_class c
  join pg_roles r on r.oid = c.relowner
  where c.relname = 'spatial_ref_sys'
    and c.relnamespace = 'public'::regnamespace;

  if owner_name is null then
    raise notice 'spatial_ref_sys not found; skipping RLS setup.';
    return;
  end if;

  if owner_name = current_user then
    execute 'alter table public.spatial_ref_sys enable row level security';
    if not exists (
      select 1 from pg_policies p
      where p.schemaname = current_schema()
        and p.tablename = 'spatial_ref_sys'
        and p.policyname = 'spatial_ref_sys_select_all'
    ) then
      execute
        'create policy spatial_ref_sys_select_all on public.spatial_ref_sys for select using (auth.role() in (''anon'',''authenticated'',''service_role''));';
    end if;
  else
    raise notice 'Skipping RLS on public.spatial_ref_sys; owner is %, current_user is %', owner_name, current_user;
  end if;
exception when insufficient_privilege then
  raise notice 'Skipping RLS on public.spatial_ref_sys due to insufficient privileges.';
end $$;
