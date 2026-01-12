# CIC UK Air Quality Networks

Tools for ingesting UK-AIR SOS data into Supabase.

## Website
The static web UI now lives in the `uk-aq` repo (under `CIC Website/uk-aq`).
This repo focuses on ingest, data management, and Supabase Edge Functions.

## Prerequisites
- Python 3.10+
- Supabase project with the schema applied from `supabase/uk_air_quality_schema.sql`
  - This schema uses bigint internal ids; external identifiers stored as text use `_ref` (even if numeric).

## Setup
Create a `.env` file in the repo root with:

```
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
# Optional override (default shown)
UK_AIR_SOS_BASE_URL=https://uk-air.defra.gov.uk/sos-ukair/api/v1
# Optional override for the service label
UK_AIR_SOS_SERVICE_LABEL=UK-AIR-SOS
# Legacy support: UK_AIR_BASE_URL, UK_AIR_SERVICE_LABEL, and UKAIR_BASE_URL also work
```

`.env` is local-only. Keep it out of git and mirror the same values in GitHub Secrets/Vars so CI matches your local runs.

Env quick reference (Supabase blocks secrets prefixed with `SUPABASE_`):

| Context | Required | Optional |
| --- | --- | --- |
| Local scripts (.env) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `UK_AIR_SOS_BASE_URL`, `UK_AIR_SOS_SERVICE_LABEL` |
| Edge function runtime (Supabase secrets) | `SB_SUPABASE_URL`, `SB_SERVICE_ROLE_KEY` | `UK_AIR_SOS_BASE_URL`, `UK_AIR_SOS_SERVICE_LABEL` |
| GitHub Actions deploy | `SUPABASE_ACCESS_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PROJECT_REF` (Secrets) | `UK_AIR_SOS_BASE_URL`, `UK_AIR_SOS_SERVICE_LABEL` (Secrets) |

Install dependencies in a virtual environment:

```
python3 -m venv .venv
source .venv/bin/activate
pip install requests python-dotenv supabase
```

## Testing
- Install dev tools: `pip install -r requirements-dev.txt` (contains pytest + mocks).
- Run mocked/unit tests (no network): `pytest`
- Run live SOS integration tests: `UKAIR_LIVE=1 pytest -m live` (read-only; skips by default)
- Optional DB writes (should stay off for tests): `UKAIR_WRITE_DB=1` (default is no writes)

## Run the UK-AIR SOS ingestion
Discover stations and timeseries, then backfill 2025:

```
python3 scripts/uk_air_sos_ingest.py --discover --backfill-2025
```

Refresh the last N hours (default 6h):

```
python3 scripts/uk_air_sos_ingest.py --refresh-recent --hours 6
```

Optional backfill chunk size (days):

```
python3 scripts/uk_air_sos_ingest.py --backfill-2025 --chunk-days 14
```

## Notes
- Filters are configurable in `scripts/uk_air_sos_ingest.py` (bbox, region, station type, pollutants).
- The script upserts into `connectors`, `stations`, `timeseries`, `observations`, and reference tables.

## Edge function polling (optional)
For continuous updates, deploy the Edge Function in `supabase/functions/ingest_uk_air_sos`.
Deploying the Edge Function does not create a schedule; the cron timing is set in `supabase/uk_aq_polling_cron.sql` (edit the cron expression there and rerun the SQL to change it).

Supabase secrets required (Edge Function runtime):
```
SB_SUPABASE_URL=your_supabase_url
SB_SERVICE_ROLE_KEY=your_service_role_key
UK_AIR_SOS_BASE_URL=https://uk-air.defra.gov.uk/sos-ukair/api/v1
UK_AIR_SOS_SERVICE_LABEL=UK-AIR-SOS
```

Example cron SQL to schedule the poller lives in `supabase/uk_aq_polling_cron.sql`.

GitHub Actions deployment secrets (used by `.github/workflows/supabase_edge_deploy.yml`):
- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_PROJECT_REF`

Note: `SUPABASE_ACCESS_TOKEN` is only required for deployments (GitHub Actions or `supabase` CLI). The publishable key is safe to expose; the service role key is not.

## Environment naming convention
For new networks, use `NETWORK_BASE_URL` and `NETWORK_SERVICE_LABEL`.
Examples:
- `UK_AIR_SOS_BASE_URL`, `UK_AIR_SOS_SERVICE_LABEL`
- `SCOMM_BASE_URL`, `SCOMM_SERVICE_LABEL` (Sensor.Community)
