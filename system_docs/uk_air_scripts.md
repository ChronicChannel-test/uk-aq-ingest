# UK-AIR Scripts

This document summarizes the UK-AIR helper scripts and their inputs/outputs.

## Environment
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `UK_AIR_BASE_URL` (optional; defaults to `https://uk-air.defra.gov.uk/sos-ukair/api/v1`)
  - The scripts also accept the legacy `UKAIR_BASE_URL` if set.

## Scripts

### `scripts/uk_air_aurn_ingest.py`
Purpose:
- Discover Bristol AURN stations and timeseries.
- Backfill 2025 observations.
- Refresh recent observations for the last N hours.

Common commands:
```
python3 scripts/uk_air_aurn_ingest.py --discover --backfill-2025
python3 scripts/uk_air_aurn_ingest.py --refresh-recent --hours 6
```

Writes to:
- `services`, `stations`, `timeseries`, `observations`

### `scripts/uk_air_list_stations.py`
Purpose:
- Fetch all current stations from UK-AIR SOS.
- Filter to UK bounding box (keeps stations with missing coordinates; `geometry` will be null in Supabase).
- Optional upsert into Supabase.

Common commands:
```
python3 scripts/uk_air_list_stations.py
python3 scripts/uk_air_list_stations.py --format csv --output uk_stations.csv
python3 scripts/uk_air_list_stations.py --to-supabase
python3 scripts/uk_air_list_stations.py --no-filter --output uk_air_stations_all.json
python3 scripts/uk_air_list_stations.py --raw-output uk_air_stations_raw.json
python3 scripts/uk_air_list_stations.py --service-id-from-timeseries
```

Default outputs:
- `uk_air_stations.json`
- `uk_air_stations_all.json` (when using `--no-filter`)
Optional raw output:
- `--raw-output` writes raw station payloads to a separate JSON file.
Service IDs:
- By default, if the SOS reports a single service, that service ID is applied to stations in the JSON output.
- The JSON output also includes a top-level `service_id` when a single service is detected.
- Use `--service-id-from-timeseries` to resolve `service_id` from timeseries metadata.

Writes to (when `--to-supabase` is set):
- `services`, `stations`
- `phenomena`, `procedures`, `offerings` (unless `--skip-metadata` is used)
  - `stations` lifecycle fields: `first_seen_at`, `last_seen_at`, `removed_at`
  - Stations not seen in the current run are marked with `removed_at`.

## SOS metadata glossary
- `phenomenon`: The observed property (pollutant/parameter), e.g., NO2, O3, PM2.5.
- `procedure`: The sensor or measurement method used to produce the observation.
- `offering`: A logical grouping of observations, often representing a dataset or station-level collection.

## Keys
- `stations` uses a composite primary key: `(id, service_id)`.
