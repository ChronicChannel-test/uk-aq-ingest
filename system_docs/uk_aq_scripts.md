# UK-AQ Scripts

This document summarizes the UK-AQ helper scripts and their inputs/outputs.

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
- `--station-like Bristol` (optional label filter)
- `--station-type AURN` (optional)
- `--strict-bbox` to exclude stations with missing coordinates
- `--pollutants no2,o3,pm10,pm2.5` (default common pollutants)
- `--all-pollutants` to disable pollutant filtering
- `--backfill-year 2025` to backfill a specific year
- `--service-ref` (alias `--service-id`) or `--service-label` to target a specific SOS service
- `--sample-timeseries 1` to log a short summary of the first N timeseries objects
- `--raw-dropbox` to write raw payloads to Dropbox (testing only; guarded by `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`)
- `--raw-dropbox-folder /raw_data` to override the Dropbox folder
- `--log-level WARNING` to reduce logging output
  - Default output prints only station count, error count, and Dropbox upload info.
Batching:
- If `services.poll_timeseries_batch_size` is set for the chosen service, it overrides the default batch size for timeseries discovery.
Stations bbox:
- If `services.stations_bbox_supported` is false, the script skips bbox when calling `/stations`.
Timeseries station filter:
- If `services.timeseries_station_filter_supported` is false, the script skips station filtering for `/timeseries`.
Phenomenon lookup:
- If a timeseries label contains a `dd.eionet.europa.eu/vocabulary/aq/pollutant/` URL and `phenomenon` is missing, the script resolves Eionet metadata and stores `phenomena.eionet_uri` + `phenomena.notation` (shortname), with `label` falling back to `prefLabel`.

Raw payloads (testing only):
- Raw payload uploads are disabled unless `SUPABASE_URL` matches `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`.
- Dropbox credentials required: `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`.
- The raw capture writes all SOS responses fetched during the run into a single gzipped JSONL file and uploads it to Dropbox.
- Uploads are organized under `raw_data/YYYY-MM-DD` within the configured Dropbox folder (for scoped apps, do not include `/Apps/<app>` in the path).
- Each run also uploads a log file to `/log/YYYY-MM-DD/` (Dropbox app root).
- Logs older than 31 days are zipped into `/log/archive/YYYY-MM-DD.zip`; archive files older than 1 year are removed.
- If `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL` is unset in live environments, the upload never runs (even if `--raw-dropbox` is passed).

### `scripts/uk_aq_load_la_boundaries.py`
Purpose:
- Load Local Authority boundary GeoJSON into `la_boundaries`.
- Optional: update `stations.la_code` + `stations.la_version` using the stored boundaries.

Common commands:
```
python3 scripts/uk_aq_load_la_boundaries.py --geojson data/lad.geojson --la-version 2023
python3 scripts/uk_aq_load_la_boundaries.py --geojson data/lad.geojson --la-version 2023 --update-stations
```

Inputs:
- GeoJSON FeatureCollection with Polygon/MultiPolygon geometries.

Key flags:
- `--code-field` (default: `la_code`)
- `--name-field` (default: `la_name`)
- `--batch-size` (default: 200)
- `--update-stations` to run `uk_aq_refresh_station_la_codes`.

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### `scripts/uk_aq_list_stations.py`
Purpose:
- Fetch all current stations from UK-AIR SOS.
- Filter to UK bounding box (keeps stations with missing coordinates; `geometry` will be null in Supabase).
- Optional upsert into Supabase.

Common commands:
```
python3 scripts/uk_aq_list_stations.py
python3 scripts/uk_aq_list_stations.py --format csv --output uk_stations.csv
python3 scripts/uk_aq_list_stations.py --to-supabase
python3 scripts/uk_aq_list_stations.py --no-filter --output uk_aq_stations_all.json
python3 scripts/uk_aq_list_stations.py --raw-output uk_aq_stations_raw.json
python3 scripts/uk_aq_list_stations.py --service-id-from-timeseries
```

Default outputs:
- `uk_aq_stations.json`
- `uk_aq_stations_all.json` (when using `--no-filter`)
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

### `scripts/uk_aq_defra_compare.py`
Purpose:
- Fetch DEFRA last-hour readings for a station.
- Compare DEFRA values to the latest Supabase observations for the same station.
- Exit non-zero when mismatches exceed the configured tolerance.

Common commands:
```
python3 scripts/uk_aq_defra_compare.py
python3 scripts/uk_aq_defra_compare.py --station-id BR11 --tolerance 1.5
python3 scripts/uk_aq_defra_compare.py --defra-url "https://uk-air.defra.gov.uk/data/site-data?f_site_id=BR11&view=last_hour"
```

Inputs:
- DEFRA last-hour page (HTML)
- `stations`, `timeseries`, `observations`, `phenomena`

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Output:
- Console report per pollutant (PASS/FAIL) with timestamps/units.
- Exit code 0 on success, 1 on mismatch, 2 on fetch/query errors.

### `scripts/uk_aq_dropbox_test.py`
Purpose:
- Validate Dropbox OAuth refresh token and optionally upload a small test file.

Common commands:
```
python3 scripts/uk_aq_dropbox_test.py
python3 scripts/uk_aq_dropbox_test.py --upload
```

Environment:
- `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`
- Optional `UK_AIR_RAW_DROPBOX_FOLDER` (defaults to `/raw_data`)

### `scripts/uk_aq_error_log_archive.py`
Purpose:
- Zip each day of per-error Dropbox logs into `/error_log/YYYY-MM-DD.zip`.
- Delete the original per-error folder after archiving.
- Delete archived ZIPs older than the retention window (default: 365 days).

Common commands:
```
python3 scripts/uk_aq_error_log_archive.py
python3 scripts/uk_aq_error_log_archive.py --date 2026-01-07
```

Environment:
- `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`
- `SUPABASE_URL` + `UK_AIR_ERROR_DROPBOX_ALLOWED_SUPABASE_URL` (must match to run)
- Optional `UK_AIR_ERROR_DROPBOX_FOLDER` (defaults to `/error_log`)

### `scripts/uk_aq_inject_project_ref.mjs`
Purpose:
- Inject `SUPABASE_PROJECT_REF` and the anon JWT into `web/uk_aq_bristol.html` for the live Edge Function URL.

Common command:
```
node scripts/uk_aq_inject_project_ref.mjs
```

Notes:
- Reads `SUPABASE_PROJECT_REF` and `SUPABASE_ANON_JWT` from `.env` or the environment (falls back to `SUPABASE_PUBLISHABLE_DEFAULT_KEY`).
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
