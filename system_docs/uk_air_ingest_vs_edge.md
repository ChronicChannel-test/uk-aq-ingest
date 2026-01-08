# Ingest Script vs Edge Function

This project uses **two different ingestion paths** that serve different purposes.

## Ingest script (`scripts/uk_air_sos_ingest.py`)

**Purpose:** full discovery + data refresh.

- Discovers services, stations, timeseries, phenomena, procedures, offerings.
- Creates/updates `timeseries` rows (including `timeseries_ref`, `station_id`, `phenomenon_id`).
- Can backfill historical data and refresh recent data.
- Writes:
  - `stations`, `timeseries`, `observations`, `phenomena`, `procedures`, `offerings`, `categories`, `features`.
- Can upload raw payloads + logs to Dropbox (optional).
- Runs locally or via GitHub Actions.

## Edge function (`supabase/functions/ingest_uk_air_sos/index.ts`)

**Purpose:** lightweight polling of existing timeseries rows.

- **Does not discover** stations/timeseries or fix missing links.
- Loads existing `timeseries` rows and polls `timeseries_ref` for recent values.
- Writes:
  - `observations`
  - `timeseries.last_value` + `timeseries.last_value_at` (update by id)
- Logs to Dropbox and `error_logs` when configured.
- Triggered by Supabase cron (`supabase/uk_air_polling_cron.sql`).

## Why both exist

- The ingest script keeps the metadata **complete and correct**.
- The edge function keeps **recent values up to date** without running discovery.

## Practical implications

- If `timeseries.station_id` is null, **run the ingest script** (`--discover`) to fix it.
- If the web page shows `—` values, check that the edge function is running and that
  `timeseries.last_value` is being updated.

