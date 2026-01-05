-- Schedule UK-AIR SOS polling via Supabase Edge Function.
-- Replace placeholders before running.

-- Create a 15-minute poll schedule.
-- SERVICE_ID should come from the `services` table (internal bigint id).
select cron.schedule(
  'ingest-uk-air-sos-15m',
  '*/15 * * * *',
  $$
    select net.http_post(
      url := 'https://nmgierafoeuxfkkscrln.supabase.co/functions/v1/ingest_uk_air_sos',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer sb_publishable_a6RslXF8rRzJqNo3RjjSSg_mFwfSNMP","apikey":"sb_publishable_a6RslXF8rRzJqNo3RjjSSg_mFwfSNMP"}'::jsonb,
      body := '{"service_id":"1","window_hours": 3}'::jsonb
    );
  $$
);

-- To disable the schedule:
-- select cron.unschedule('ingest-uk-air-sos-15m');
