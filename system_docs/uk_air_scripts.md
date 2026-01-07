# UK-AIR Scripts

This document summarizes the UK-AIR helper scripts and their inputs/outputs.

## Environment
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `UK_AIR_SOS_BASE_URL` (optional; defaults to `https://uk-air.defra.gov.uk/sos-ukair/api/v1`)
  - The scripts also accept the legacy `UK_AIR_BASE_URL` or `UKAIR_BASE_URL` if set.
- `UK_AIR_SOS_SERVICE_LABEL` (optional; defaults to `UK-AIR-SOS`)

## Scripts

### `scripts/uk_air_sos_ingest.py`
Purpose:
- Discover stations and timeseries with optional filters.
- Backfill observations for a chosen year.
- Refresh recent observations for the last N hours.

Common commands:
```
python3 scripts/uk_air_sos_ingest.py --discover --backfill-2025
python3 scripts/uk_air_sos_ingest.py --refresh-recent --hours 6
```

Writes to:
- `services`, `stations`, `timeseries`, `observations`

Key flags:
- `--bbox west,south,east,north` (default: UK bbox)
- `--region Bristol` (optional)
- `--station-type AURN` (optional)
- `--strict-bbox` to exclude stations with missing coordinates
- `--pollutants no2,o3,pm10,pm2.5` (default common pollutants)
- `--all-pollutants` to disable pollutant filtering
- `--backfill-year 2025` to backfill a specific year
- `--service-ref` (alias `--service-id`) or `--service-label` to target a specific SOS service
- `--sample-timeseries 1` to log a short summary of the first N timeseries objects
Batching:
- If `services.poll_timeseries_batch_size` is set for the chosen service, it overrides the default batch size for timeseries discovery.
Stations bbox:
- If `services.stations_bbox_supported` is false, the script skips bbox when calling `/stations`.
Timeseries station filter:
- If `services.timeseries_station_filter_supported` is false, the script skips station filtering for `/timeseries`.
Phenomenon lookup:
- If a timeseries label contains a `dd.eionet.europa.eu/vocabulary/aq/pollutant/` URL and `phenomenon` is missing, the script resolves Eionet metadata and stores `phenomena.eionet_uri` + `phenomena.notation` (shortname), with `label` falling back to `prefLabel`.

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
Service refs:
- By default, if the SOS reports a single service, that service ref is applied to stations in the JSON output.
- The JSON output also includes a top-level `service_ref` when a single service is detected.
- Use `--service-ref-from-timeseries` (alias `--service-id-from-timeseries`) to resolve `service_ref` from timeseries metadata.
- The internal attribute is named `service_ref_from_timeseries` to match the `_ref` convention; the legacy flag name still works for compatibility.

Writes to (when `--to-supabase` is set):
- `services`, `stations`
- `phenomena`, `procedures`, `offerings` (unless `--skip-metadata` is used)
  - `stations` lifecycle fields: `first_seen_at`, `last_seen_at`, `removed_at`
  - Stations not seen in the current run are marked with `removed_at`.

### `scripts/uk_air_inject_project_ref.mjs`
Purpose:
- Inject `SUPABASE_PROJECT_REF` into `web/uk_air_bristol.html` for the live Edge Function URL.

Common command:
```
node scripts/uk_air_inject_project_ref.mjs
```

Notes:
- Reads `SUPABASE_PROJECT_REF` from `.env` or the environment.
- A pre-commit hook in `.githooks/pre-commit` runs this automatically; enable it with:
```
git config core.hooksPath .githooks
```

## SOS metadata glossary
- `phenomenon`: The observed property (pollutant/parameter), e.g., NO2, O3, PM2.5.
- `procedure`: The sensor or measurement method used to produce the observation.
- `offering`: A logical grouping of observations, often representing a dataset or station-level collection.

## Keys
- `stations` uses bigint `id` with `station_ref` for upstream identifiers (unique by `service_id, station_ref`).
- `timeseries` uses bigint `id` with `timeseries_ref` for upstream identifiers (unique by `service_id, timeseries_ref`).
- `observations` references `timeseries.id` (bigint) and uses `(timeseries_id, observed_at)` as the primary key.
- External identifiers that arrive as text (even if numeric) use `*_ref`; internal joins always use bigint `*_id`.
