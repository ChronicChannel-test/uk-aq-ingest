# UK-AIR SOS Network

This network pulls stations from the UK-AIR SOS API with configurable filters.

## Source
- UK-AIR SOS REST API
- Base URL: `https://uk-air.defra.gov.uk/sos-ukair/api/v1`

## Filters
Applied in `scripts/uk_air_sos_ingest.py`:
- Bounding box: default is UK bbox (west -11.0, south 49.0, east 2.0, north 61.0)
- Region label: optional
- Station type: optional (e.g., `AURN`)
- Pollutants: default `NO2`, `O3`, `PM10`, `PM2.5` (use `--all-pollutants` to disable filtering)
  - `--strict-bbox` excludes stations with missing coordinates
  - Pollutant matching is tolerant (aliases like NO2/Nitrogen Dioxide, PM2.5/PM25).

## Ingestion flow
1) Discover service metadata (`/services`).
2) Fetch stations (`/stations`) and apply filters.
3) Fetch timeseries (`/timeseries?expanded=true`) and filter to target pollutants (if set).
4) Backfill 2025 observations (`/timeseries/{id}/getData?timespan=2025-01-01/2026-01-01`).
5) Refresh recent observations for the last N hours (default 6h).

## Destination tables
- `services`
- `stations`
- `timeseries`
- `observations`
- `phenomena`
- `procedures`
- `offerings`

## Station pollutant coverage
- Station-to-pollutant coverage is derived from `timeseries` (via `timeseries.phenomenon_id`).
- `stations` does not store a single pollutant because stations often monitor multiple pollutants.

## IDs
- `stations` and `timeseries` use bigint `id` internally, with upstream identifiers stored in `source_id`.
- `observations` references `timeseries.id`.

## Commands
```
python3 scripts/uk_air_sos_ingest.py --discover --backfill-2025
python3 scripts/uk_air_sos_ingest.py --refresh-recent --hours 6

# Example: AURN stations in Bristol only
python3 scripts/uk_air_sos_ingest.py --station-type AURN --region Bristol --bbox -2.75,51.30,-2.45,51.55 --discover
```

## Edge function polling
The Edge Function `ingest_uk_air_sos` polls recent observations using the existing `timeseries` rows.

Environment variables (Supabase secrets):
- `SB_SUPABASE_URL`
- `SB_SERVICE_ROLE_KEY`
- `UK_AIR_SOS_BASE_URL` (optional override)
- `UK_AIR_SOS_SERVICE_LABEL` (optional override)

For local runs, keep the `SUPABASE_*` values in `.env` (gitignored). For Edge Functions, use `SB_*` secrets instead. `SUPABASE_ACCESS_TOKEN` is only needed for deployment, not for runtime polling.

Env quick reference (Supabase blocks secrets prefixed with `SUPABASE_`):

| Context | Required | Optional |
| --- | --- | --- |
| Local scripts (.env) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `UK_AIR_SOS_BASE_URL`, `UK_AIR_SOS_SERVICE_LABEL` |
| Edge function runtime (Supabase secrets) | `SB_SUPABASE_URL`, `SB_SERVICE_ROLE_KEY` | `UK_AIR_SOS_BASE_URL`, `UK_AIR_SOS_SERVICE_LABEL` |
| GitHub Actions deploy | `SUPABASE_ACCESS_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PROJECT_REF` (Secrets) | `UK_AIR_SOS_BASE_URL`, `UK_AIR_SOS_SERVICE_LABEL` (Secrets) |

Request body options (JSON):
- `service_id` or `service_label` (optional; defaults to `UK-AIR-SOS`)
- `window_hours` (optional; defaults to `services.poll_window_hours` or 6)
- `pollutants` (optional; array or comma-separated list)
- `timeseries_ids` (optional; array or comma-separated list of source_id or internal id)
- `timeseries_limit` (optional; integer)

When `service_id` is provided, the function uses `services.service_url` from the database.
Environment variables are only a fallback for discovery or missing service rows.

If `timeseries_limit` is not provided, the function uses `services.poll_timeseries_batch_size` when set.

Scheduling SQL lives in `supabase/uk_air_polling_cron.sql` and uses `net.http_post` to invoke the function.
