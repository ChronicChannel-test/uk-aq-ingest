-- Schedule UK-AIR SOS polling via Supabase Edge Function.
-- Replace placeholders before running.

-- Create a 15-minute poll schedule (5 minutes past the quarter-hour).
-- CONNECTOR_ID should come from the `connectors` table (internal bigint id).
select cron.schedule(
  'ingest-uk-air-sos-15m',
  '5,20,35,50 * * * *',
  $$
    select net.http_post(
      url := 'https://nmgierafoeuxfkkscrln.supabase.co/functions/v1/ingest_uk_air_sos',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5tZ2llcmFmb2V1eGZra3NjcmxuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUzMjIzMDMsImV4cCI6MjA4MDg5ODMwM30.x6rKhvMTFRyJCZNlaFG-5tUiSuwehCLLu3qbulNTe7A","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5tZ2llcmFmb2V1eGZra3NjcmxuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUzMjIzMDMsImV4cCI6MjA4MDg5ODMwM30.x6rKhvMTFRyJCZNlaFG-5tUiSuwehCLLu3qbulNTe7A"}'::jsonb,
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
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5tZ2llcmFmb2V1eGZra3NjcmxuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUzMjIzMDMsImV4cCI6MjA4MDg5ODMwM30.x6rKhvMTFRyJCZNlaFG-5tUiSuwehCLLu3qbulNTe7A","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5tZ2llcmFmb2V1eGZra3NjcmxuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUzMjIzMDMsImV4cCI6MjA4MDg5ODMwM30.x6rKhvMTFRyJCZNlaFG-5tUiSuwehCLLu3qbulNTe7A"}'::jsonb,
      body := '{"connector_code":"sensorcommunity","country":"GB"}'::jsonb
    );
  $$
);

-- To disable the schedule:
-- select cron.unschedule('ingest-uk-air-sos-15m');
-- select cron.unschedule('ingest-sensorcommunity-15m');
