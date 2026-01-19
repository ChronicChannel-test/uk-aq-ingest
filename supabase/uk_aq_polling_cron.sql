-- Schedule UK-AIR SOS polling via Supabase Edge Function.
-- Replace placeholders before running:
--   - {{SUPABASE_ANON_JWT}}
--   - {{SB_UK_AQ_CRON_SECRET}}

-- Reset schedules so this script can be re-applied safely.
select cron.unschedule('ingest-uk-air-sos-15m');
select cron.unschedule('ingest-sensorcommunity-15m');
select cron.unschedule('ingest-breathelondon-hourly');

-- Create a 15-minute poll schedule (5 minutes past the quarter-hour).
-- CONNECTOR_ID should come from the `connectors` table (internal bigint id).
select cron.schedule(
  'ingest-uk-air-sos-15m',
  '5,20,35,50 * * * *',
  $$
    select net.http_post(
      url := 'https://nmgierafoeuxfkkscrln.supabase.co/functions/v1/ingest_uk_air_sos',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer {{SUPABASE_ANON_JWT}}","apikey":"{{SUPABASE_ANON_JWT}}","X-Cron-Secret":"{{SB_UK_AQ_CRON_SECRET}}"}'::jsonb,
      body := '{"connector_id":"1","window_hours": 3}'::jsonb
    );
  $$
);

-- Create a 15-minute Sensor.Community poll schedule (10 minutes past the quarter-hour).
select cron.schedule(
  'ingest-sensorcommunity-15m',
  '10,25,40,55 * * * *',
  $$
    select net.http_post(
      url := 'https://nmgierafoeuxfkkscrln.supabase.co/functions/v1/ingest_sensorcommunity',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer {{SUPABASE_ANON_JWT}}","apikey":"{{SUPABASE_ANON_JWT}}","X-Cron-Secret":"{{SB_UK_AQ_CRON_SECRET}}"}'::jsonb,
      body := '{"connector_code":"sensorcommunity","country":"GB"}'::jsonb
    );
  $$
);

-- Create an hourly Breathe London poll schedule (12 minutes past the hour).
select cron.schedule(
  'ingest-breathelondon-hourly',
  '12 * * * *',
  $$
    select net.http_post(
      url := 'https://nmgierafoeuxfkkscrln.supabase.co/functions/v1/ingest_breathelondon',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer {{SUPABASE_ANON_JWT}}","apikey":"{{SUPABASE_ANON_JWT}}","X-Cron-Secret":"{{SB_UK_AQ_CRON_SECRET}}"}'::jsonb,
      body := '{"connector_code":"breathelondon","skip_stations":true,"active_only":true}'::jsonb
    );
  $$
);

-- To disable the schedule:
-- select cron.unschedule('ingest-uk-air-sos-15m');
-- select cron.unschedule('ingest-sensorcommunity-15m');
-- select cron.unschedule('ingest-breathelondon-hourly');
