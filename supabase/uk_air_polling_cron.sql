-- Schedule UK-AIR SOS polling via Supabase Edge Function.
-- Replace placeholders before running.

-- Create a 15-minute poll schedule.
-- SERVICE_ID should come from the `services` table (e.g., select id from services).
select cron.schedule(
  'ingest-uk-air-sos-15m',
  '*/15 * * * *',
  $$
    select net.http_post(
      url := 'https://<PROJECT_REF>.supabase.co/functions/v1/ingest_uk_air_sos',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer <SUPABASE_ANON_KEY>"}'::jsonb,
      body := '{"service_id":"<SERVICE_ID>","window_hours": 3}'::jsonb
    );
  $$
);

-- To disable the schedule:
-- select cron.unschedule('ingest-uk-air-sos-15m');
