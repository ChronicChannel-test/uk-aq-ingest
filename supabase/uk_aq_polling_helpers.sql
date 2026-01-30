-- Helper RPCs for the dispatcher (no pg_cron schedules).
-- Functions live in uk_aq_core and read uk_aq_raw checkpoints.

create or replace function uk_aq_core.breathelondon_select_station_refs(
  batch_limit integer default 10,
  active_only boolean default true
)
returns text[]
language plpgsql
set search_path = uk_aq_core, uk_aq_raw, public, pg_catalog
as $$
declare
  v_connector_id bigint;
  station_refs text[];
begin
  select id into v_connector_id
  from connectors
  where connector_code = 'breathelondon'
  limit 1;

  if v_connector_id is null then
    return null;
  end if;

  with latest_fetch as (
    select
      station_id,
      min(last_fetch_at) as last_fetch_at
    from breathelondon_timeseries_checkpoints
    group by station_id
  ),
  candidates as (
    select
      stn.station_ref,
      lf.last_fetch_at
    from stations stn
    left join latest_fetch lf on lf.station_id = stn.id
    left join station_metadata sm on sm.station_id = stn.id
    where stn.connector_id = v_connector_id
      and stn.service_ref = 'breathelondon'
      and stn.station_ref is not null
      and stn.removed_at is null
      and (
        not active_only
        or lower(coalesce(sm.attributes->>'enabled', '')) in ('y','yes','true','1')
        or lower(coalesce(sm.attributes->>'site_active', '')) in ('y','yes','true','1')
      )
    order by (lf.last_fetch_at is not null), lf.last_fetch_at, stn.station_ref
    limit batch_limit
  )
  select array_agg(station_ref) into station_refs
  from candidates;

  return station_refs;
end;
$$;

create or replace function uk_aq_core.erg_laqn_select_station_refs(
  batch_limit integer default 10,
  active_only boolean default true
)
returns text[]
language plpgsql
set search_path = uk_aq_core, uk_aq_raw, public, pg_catalog
as $$
declare
  v_connector_id bigint;
  station_refs text[];
begin
  select id into v_connector_id
  from connectors
  where connector_code = 'erg_laqn'
  limit 1;

  if v_connector_id is null then
    return null;
  end if;

  with latest_obs as (
    select
      t.station_id,
      max(o.observed_at) as latest_observed_at
    from timeseries t
    join observations o on o.timeseries_id = t.id
    where t.connector_id = v_connector_id
      and t.service_ref = 'erg_laqn'
    group by t.station_id
  ),
  candidates as (
    select
      stn.station_ref,
      lo.latest_observed_at,
      esc.last_polled_at
    from stations stn
    left join latest_obs lo on lo.station_id = stn.id
    left join erg_laqn_station_checkpoints esc on esc.station_id = stn.id
    where stn.connector_id = v_connector_id
      and stn.service_ref = 'erg_laqn'
      and stn.station_ref is not null
      and (not active_only or stn.removed_at is null)
    order by esc.last_polled_at nulls first,
      stn.station_ref
    limit batch_limit
  )
  select array_agg(station_ref) into station_refs
  from candidates;

  return station_refs;
end;
$$;

create or replace function uk_aq_core.openaq_select_station_refs(
  batch_limit integer default 56,
  stale_limit integer default 4
)
returns text[]
language plpgsql
set search_path = uk_aq_core, uk_aq_raw, public, pg_catalog
as $$
declare
  v_connector_id bigint;
  station_refs text[];
begin
  select id into v_connector_id
  from connectors
  where connector_code = 'openaq'
  limit 1;

  if v_connector_id is null then
    return null;
  end if;

  with latest_obs as (
    select
      t.station_id,
      max(t.last_value_at) as last_observed_at
    from timeseries t
    where t.connector_id = v_connector_id
      and t.service_ref = 'openaq'
    group by t.station_id
  ),
  candidates as (
    select
      stn.id as station_id,
      stn.station_ref,
      osc.next_due_at,
      osc.last_polled_at,
      coalesce(osc.last_observed_at, lo.last_observed_at) as last_observed_at,
      coalesce(osc.next_due_at, now()) as due_at
    from stations stn
    left join openaq_station_checkpoints osc
      on osc.station_id = stn.id
    left join latest_obs lo
      on lo.station_id = stn.id
    where stn.connector_id = v_connector_id
      and stn.service_ref = 'openaq'
      and stn.station_ref is not null
      and stn.removed_at is null
  ),
  tiered as (
    select
      station_id,
      station_ref,
      due_at
    from candidates
    where due_at <= now()
      and due_at >= now() - interval '3 hours'
      and (last_polled_at is null or last_polled_at <= now() - interval '5 minutes')
    union all
    select
      station_id,
      station_ref,
      due_at
    from candidates
    where due_at < now() - interval '3 hours'
      and due_at >= now() - interval '24 hours'
      and (last_polled_at is null or last_polled_at <= now() - interval '1 hour')
  ),
  tiered_limited as (
    select *
    from tiered
    order by due_at asc
    limit batch_limit
  ),
  stale as (
    select
      c.station_id,
      c.station_ref,
      c.last_observed_at
    from candidates c
    where (c.last_observed_at is null or c.last_observed_at <= now() - interval '24 hours')
      and (c.last_polled_at is null or c.last_polled_at <= now() - interval '12 hours')
      and not exists (
        select 1 from tiered_limited t where t.station_id = c.station_id
      )
    order by c.last_observed_at nulls first
    limit stale_limit
  ),
  combined as (
    select station_ref, 1 as group_order, due_at as sort_at
    from tiered_limited
    union all
    select station_ref, 2 as group_order, null as sort_at
    from stale
  )
  select array_agg(combined.station_ref order by group_order, sort_at nulls last)
  into station_refs
  from combined;

  return station_refs;
end;
$$;
