# UK-AIR AURN (Bristol) Network

This network pulls AURN stations located in Bristol from the UK-AIR SOS API.

## Source
- UK-AIR SOS REST API
- Base URL: `https://uk-air.defra.gov.uk/sos-ukair/api/v1`

## Filters
Applied in `scripts/uk_air_aurn_ingest.py`:
- Bounding box: west -2.75, south 51.30, east -2.45, north 51.55
- Region label: `Bristol` (used when supported by the API)
- Station type: `AURN`
- Pollutants: NO2, O3, PM10, PM2.5

## Ingestion flow
1) Discover service metadata (`/services`).
2) Fetch stations (`/stations`) and filter to Bristol AURN.
3) Fetch timeseries (`/timeseries?expanded=true`) and filter to target pollutants.
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

## Commands
```
python3 scripts/uk_air_aurn_ingest.py --discover --backfill-2025
python3 scripts/uk_air_aurn_ingest.py --refresh-recent --hours 6
```
