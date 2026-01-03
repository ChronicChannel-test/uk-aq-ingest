# CIC UK Air Quality Networks

Tools for ingesting UK-AIR SOS data (Bristol AURN focus) into Supabase.

## Prerequisites
- Python 3.10+
- Supabase project with the schema applied from `supabase/uk_air_quality_schema.sql`

## Setup
Create a `.env` file in the repo root with:

```
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
# Optional override (default shown)
UK_AIR_BASE_URL=https://uk-air.defra.gov.uk/sos-ukair/api/v1
# Legacy support: UKAIR_BASE_URL also works
```

Install dependencies in a virtual environment:

```
python3 -m venv .venv
source .venv/bin/activate
pip install requests python-dotenv supabase
```

## Run the Bristol AURN SOS ingestion
Discover Bristol AURN stations and timeseries, then backfill 2025:

```
python3 scripts/uk_air_aurn_ingest.py --discover --backfill-2025
```

Refresh the last N hours (default 6h):

```
python3 scripts/uk_air_aurn_ingest.py --refresh-recent --hours 6
```

Optional backfill chunk size (days):

```
python3 scripts/uk_air_aurn_ingest.py --backfill-2025 --chunk-days 14
```

## Notes
- The Bristol AURN filter is defined in `scripts/uk_air_aurn_ingest.py` (bounding box, region, station type, pollutants).
- The script upserts into `services`, `stations`, `timeseries`, and `observations`.
