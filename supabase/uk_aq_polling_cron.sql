-- Schedule UK-AIR SOS polling via Supabase Edge Function.
-- Replace placeholders before running:
--   - {{SUPABASE_URL}}
--   - {{SB_ANON_JWT}}
--   - {{SB_UK_AQ_CRON_SECRET}}

-- Reset schedules so this script can be re-applied safely.
do $$
declare
  job_name text;
begin
  for job_name in
    select unnest(array[
      'ingest-uk-air-sos-15m',
      'ingest-sensorcommunity-15m',
      'ingest-erg-laqn-15m',
      'ingest-erg-laqn-batch-5m',
      'ingest-breathelondon-hourly',
      'ingest-breathelondon-batch-3m-a',
      'ingest-breathelondon-batch-3m-b'
    ])
  loop
    if exists (select 1 from cron.job where jobname = job_name) then
      perform cron.unschedule(job_name);
    end if;
  end loop;
end $$;

create or replace function uk_air_sos_dispatch_poll(
  window_hours integer default 3
)
returns void
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_connector_id bigint;
  v_poll_enabled boolean;
  lock_key bigint := hashtext('uk_air_sos_dispatch_poll')::bigint;
begin
  if not pg_try_advisory_lock(lock_key) then
    raise notice 'uk_air_sos_dispatch_poll skipped (lock held)';
    return;
  end if;

  begin
    select id, poll_enabled into v_connector_id, v_poll_enabled
    from connectors
    where connector_code = 'uk_air_sos'
    limit 1;

    if v_connector_id is null then
      raise notice 'uk_air_sos_dispatch_poll skipped (missing connector)';
    elsif not coalesce(v_poll_enabled, true) then
      raise notice 'uk_air_sos_dispatch_poll skipped (poll disabled)';
    else
      perform net.http_post(
        url := '{{SUPABASE_URL}}/functions/v1/ingest_uk_air_sos',
        headers := '{"Content-Type":"application/json","Authorization":"Bearer {{SB_ANON_JWT}}","apikey":"{{SB_ANON_JWT}}","X-Cron-Secret":"{{SB_UK_AQ_CRON_SECRET}}"}'::jsonb,
        body := jsonb_build_object(
          'connector_id', '1',
          'window_hours', window_hours
        )
      );
    end if;
  exception
    when others then
      perform pg_advisory_unlock(lock_key);
      raise;
  end;

  perform pg_advisory_unlock(lock_key);
end;
$$;

create or replace function sensorcommunity_dispatch_poll(
  country text default 'GB'
)
returns void
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_connector_id bigint;
  v_poll_enabled boolean;
  lock_key bigint := hashtext('sensorcommunity_dispatch_poll')::bigint;
begin
  if not pg_try_advisory_lock(lock_key) then
    raise notice 'sensorcommunity_dispatch_poll skipped (lock held)';
    return;
  end if;

  begin
    select id, poll_enabled into v_connector_id, v_poll_enabled
    from connectors
    where connector_code = 'sensorcommunity'
    limit 1;

    if v_connector_id is null then
      raise notice 'sensorcommunity_dispatch_poll skipped (missing connector)';
    elsif not coalesce(v_poll_enabled, true) then
      raise notice 'sensorcommunity_dispatch_poll skipped (poll disabled)';
    else
      perform net.http_post(
        url := '{{SUPABASE_URL}}/functions/v1/ingest_sensorcommunity',
        headers := '{"Content-Type":"application/json","Authorization":"Bearer {{SB_ANON_JWT}}","apikey":"{{SB_ANON_JWT}}","X-Cron-Secret":"{{SB_UK_AQ_CRON_SECRET}}"}'::jsonb,
        body := jsonb_build_object(
          'connector_code', 'sensorcommunity',
          'country', country
        )
      );
    end if;
  exception
    when others then
      perform pg_advisory_unlock(lock_key);
      raise;
  end;

  perform pg_advisory_unlock(lock_key);
end;
$$;

create or replace function breathelondon_dispatch_batch(
  batch_limit integer default 10,
  initial_days integer default 2,
  active_only boolean default true
)
returns void
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_connector_id bigint;
  v_poll_enabled boolean;
  station_refs text[];
  lock_key bigint := hashtext('breathelondon_dispatch_batch')::bigint;
begin
  if not pg_try_advisory_lock(lock_key) then
    raise notice 'breathelondon_dispatch_batch skipped (lock held)';
    return;
  end if;

  begin
    select id, poll_enabled into v_connector_id, v_poll_enabled
    from connectors
    where connector_code = 'breathelondon'
    limit 1;

    if v_connector_id is null then
      raise notice 'breathelondon_dispatch_batch skipped (missing connector)';
    elsif not coalesce(v_poll_enabled, true) then
      raise notice 'breathelondon_dispatch_batch skipped (poll disabled)';
    else
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

      if station_refs is null or array_length(station_refs, 1) is null then
        raise notice 'breathelondon_dispatch_batch skipped (no stations)';
      else
        perform net.http_post(
          url := '{{SUPABASE_URL}}/functions/v1/ingest_breathelondon',
          headers := '{"Content-Type":"application/json","Authorization":"Bearer {{SB_ANON_JWT}}","apikey":"{{SB_ANON_JWT}}","X-Cron-Secret":"{{SB_UK_AQ_CRON_SECRET}}"}'::jsonb,
          body := jsonb_build_object(
            'connector_code', 'breathelondon',
            'service_ref', 'breathelondon',
            'station_refs', station_refs,
            'skip_stations', true,
            'active_only', active_only,
            'initial_days', initial_days
          )
        );
      end if;
    end if;
  exception
    when others then
      perform pg_advisory_unlock(lock_key);
      raise;
  end;

  perform pg_advisory_unlock(lock_key);
end;
$$;

create or replace function breathelondon_select_station_refs(
  batch_limit integer default 10,
  active_only boolean default true
)
returns text[]
language plpgsql
set search_path = public, pg_catalog
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

create or replace function erg_laqn_select_station_refs(
  batch_limit integer default 10,
  active_only boolean default true
)
returns text[]
language plpgsql
set search_path = public, pg_catalog
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
    order by lo.latest_observed_at nulls first,
      esc.last_polled_at nulls first,
      stn.station_ref
    limit batch_limit
  )
  select array_agg(station_ref) into station_refs
  from candidates;

  return station_refs;
end;
$$;

create or replace function erg_laqn_dispatch_batch(
  batch_limit integer default 10,
  days integer default 1,
  group_name text default 'London',
  active_only boolean default true
)
returns void
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_connector_id bigint;
  v_poll_enabled boolean;
  station_refs text[];
  lock_key bigint := hashtext('erg_laqn_dispatch_batch')::bigint;
begin
  if not pg_try_advisory_lock(lock_key) then
    raise notice 'erg_laqn_dispatch_batch skipped (lock held)';
    return;
  end if;

  begin
    select id, poll_enabled into v_connector_id, v_poll_enabled
    from connectors
    where connector_code = 'erg_laqn'
    limit 1;

    if v_connector_id is null then
      raise notice 'erg_laqn_dispatch_batch skipped (missing connector)';
    elsif not coalesce(v_poll_enabled, true) then
      raise notice 'erg_laqn_dispatch_batch skipped (poll disabled)';
    else
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
        order by lo.latest_observed_at nulls first,
          esc.last_polled_at nulls first,
          stn.station_ref
        limit batch_limit
      )
      select array_agg(station_ref) into station_refs
      from candidates;

      if station_refs is null or array_length(station_refs, 1) is null then
        raise notice 'erg_laqn_dispatch_batch skipped (no stations)';
      else
        perform net.http_post(
          url := '{{SUPABASE_URL}}/functions/v1/ingest_erg_laqn',
          headers := '{"Content-Type":"application/json","Authorization":"Bearer {{SB_ANON_JWT}}","apikey":"{{SB_ANON_JWT}}","X-Cron-Secret":"{{SB_UK_AQ_CRON_SECRET}}"}'::jsonb,
          body := jsonb_build_object(
            'connector_code', 'erg_laqn',
            'service_ref', 'erg_laqn',
            'group', group_name,
            'days', days,
            'station_refs', station_refs
          )
        );
      end if;
    end if;
  exception
    when others then
      perform pg_advisory_unlock(lock_key);
      raise;
  end;

  perform pg_advisory_unlock(lock_key);
end;
$$;

-- Legacy pg_cron schedules removed; use an external scheduler to call
-- `uk_aq_dispatch_polls` instead of `net.http_post` from Postgres.
