-- Schedule UK-AIR SOS polling via Supabase Edge Function.
-- Replace placeholders before running:
--   - {{SUPABASE_URL}}
--   - {{SUPABASE_ANON_JWT}}
--   - {{SB_UK_AQ_CRON_SECRET}}

-- Reset schedules so this script can be re-applied safely.
select cron.unschedule('ingest-uk-air-sos-15m');
select cron.unschedule('ingest-sensorcommunity-15m');
select cron.unschedule('ingest-erg-laqn-15m');
select cron.unschedule('ingest-breathelondon-hourly'); -- Legacy cleanup.
select cron.unschedule('ingest-breathelondon-batch-3m-a');
select cron.unschedule('ingest-breathelondon-batch-3m-b');

create or replace function uk_aq_breathelondon_dispatch_batch(
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
  station_refs text[];
  lock_key bigint := hashtext('uk_aq_breathelondon_dispatch_batch')::bigint;
begin
  if not pg_try_advisory_lock(lock_key) then
    raise notice 'uk_aq_breathelondon_dispatch_batch skipped (lock held)';
    return;
  end if;

  begin
    select id into v_connector_id
    from connectors
    where connector_code = 'breathelondon'
    limit 1;

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

    if v_connector_id is null then
      raise notice 'uk_aq_breathelondon_dispatch_batch skipped (missing connector)';
    elsif station_refs is null or array_length(station_refs, 1) is null then
      raise notice 'uk_aq_breathelondon_dispatch_batch skipped (no stations)';
    else
      perform net.http_post(
        url := '{{SUPABASE_URL}}/functions/v1/ingest_breathelondon',
        headers := '{"Content-Type":"application/json","Authorization":"Bearer {{SUPABASE_ANON_JWT}}","apikey":"{{SUPABASE_ANON_JWT}}","X-Cron-Secret":"{{SB_UK_AQ_CRON_SECRET}}"}'::jsonb,
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
  exception
    when others then
      perform pg_advisory_unlock(lock_key);
      raise;
  end;

  perform pg_advisory_unlock(lock_key);
end;
$$;

-- Create a 15-minute poll schedule (5 minutes past the quarter-hour).
-- CONNECTOR_ID should come from the `connectors` table (internal bigint id).
select cron.schedule(
  'ingest-uk-air-sos-15m',
  '5,20,35,50 * * * *', -- Every 15 minutes at :05, :20, :35, :50.
  $$
    select net.http_post(
      url := '{{SUPABASE_URL}}/functions/v1/ingest_uk_air_sos',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer {{SUPABASE_ANON_JWT}}","apikey":"{{SUPABASE_ANON_JWT}}","X-Cron-Secret":"{{SB_UK_AQ_CRON_SECRET}}"}'::jsonb,
      body := '{"connector_id":"1","window_hours": 3}'::jsonb
    );
  $$
);

-- Create a 15-minute Sensor.Community poll schedule (10 minutes past the quarter-hour).
select cron.schedule(
  'ingest-sensorcommunity-15m',
  '10,25,40,55 * * * *', -- Every 15 minutes at :10, :25, :40, :55.
  $$
    select net.http_post(
      url := '{{SUPABASE_URL}}/functions/v1/ingest_sensorcommunity',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer {{SUPABASE_ANON_JWT}}","apikey":"{{SUPABASE_ANON_JWT}}","X-Cron-Secret":"{{SB_UK_AQ_CRON_SECRET}}"}'::jsonb,
      body := '{"connector_code":"sensorcommunity","country":"GB"}'::jsonb
    );
  $$
);

-- Create a 15-minute ERG LAQN poll schedule (on the quarter-hour).
select cron.schedule(
  'ingest-erg-laqn-15m',
  '0,15,30,45 * * * *', -- Every 15 minutes at :00, :15, :30, :45.
  $$
    select net.http_post(
      url := '{{SUPABASE_URL}}/functions/v1/ingest_erg_laqn',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer {{SUPABASE_ANON_JWT}}","apikey":"{{SUPABASE_ANON_JWT}}","X-Cron-Secret":"{{SB_UK_AQ_CRON_SECRET}}"}'::jsonb,
      body := '{"connector_code":"erg_laqn","service_ref":"erg_laqn","group":"London","days":1}'::jsonb
    );
  $$
);

-- Breathe London batcher via cron (approx. 1m30s cadence using two 3-minute schedules).
select cron.schedule(
  'ingest-breathelondon-batch-3m-a',
  '*/3 * * * *', -- Every 3 minutes on the minute (:00, :03, :06, ...).
  $$
    select uk_aq_breathelondon_dispatch_batch(10, 2, true);
  $$
);

select cron.schedule(
  'ingest-breathelondon-batch-3m-b',
  '1-59/3 * * * *', -- Every 3 minutes offset by 1 minute (:01, :04, :07, ...).
  $$
    select uk_aq_breathelondon_dispatch_batch(10, 2, true);
  $$
);

-- To disable the schedule:
-- select cron.unschedule('ingest-uk-air-sos-15m');
-- select cron.unschedule('ingest-sensorcommunity-15m');
-- select cron.unschedule('ingest-erg-laqn-15m');
-- select cron.unschedule('ingest-breathelondon-hourly'); -- Legacy cleanup.
-- select cron.unschedule('ingest-breathelondon-batch-3m-a');
-- select cron.unschedule('ingest-breathelondon-batch-3m-b');
