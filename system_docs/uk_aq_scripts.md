# UK-AQ Scripts

This document summarizes the UK-AQ helper scripts and their inputs/outputs.

## Environment
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `UK_AIR_SOS_BASE_URL` (optional; defaults to `https://uk-air.defra.gov.uk/sos-ukair/api/v1`)
  - The scripts also accept the legacy `UK_AIR_BASE_URL` or `UKAIR_BASE_URL` if set.
- `UK_AIR_SOS_SERVICE_LABEL` (optional; defaults to `UK-AIR-SOS`)
- `SCOMM_BASE_URL` (optional; defaults to `https://data.sensor.community`)
- `SCOMM_CONNECTOR_CODE` (optional; defaults to `sensorcommunity`; legacy `SCOMM_CONNECTOR_REF` supported)
- `SCOMM_SERVICE_REF` (optional; defaults to `SCOMM_CONNECTOR_CODE`)
- `SCOMM_SERVICE_LABEL` (optional; defaults to `Sensor.Community`; legacy `SCOMM_CONNECTOR_LABEL` supported)
- `SCOMM_COUNTRY` (optional; defaults to `GB`)
- `SCOMM_USER_AGENT` (optional; identifies your client when polling Sensor.Community)
- `SCOMM_INGEST_MET_FIELDS` (optional; defaults to `false`; enable temperature/humidity/pressure ingestion)
- `SCOMM_LOG_LEVEL` (optional; defaults to `INFO`)

## Scripts

### `scripts/uk_aq_inject_project_ref.mjs`
Purpose:
- Replace Supabase placeholders in web assets during GitHub Actions deploys.

Placeholders:
- `__SUPABASE_PROJECT_REF__` or `{{SUPABASE_PROJECT_REF}}`
- `__SUPABASE_PUBLISHABLE_DEFAULT_KEY__` or `{{SUPABASE_PUBLISHABLE_DEFAULT_KEY}}`
- `__SUPABASE_ANON_JWT__` or `{{SUPABASE_ANON_JWT}}`

Notes:
- If no placeholders are found, the script exits without changes.
- Optional: `UK_AQ_INJECT_PATHS` (comma-separated file paths) to limit which files are scanned.

Environment:
- `SUPABASE_PROJECT_REF`
- `SUPABASE_PUBLISHABLE_DEFAULT_KEY`
- `SUPABASE_ANON_JWT`

### `scripts/uk_air_sos/uk_air_sos_ingest.py`
Purpose:
- Discover stations and timeseries with optional filters.
- Backfill observations for a chosen year.
- Refresh recent observations for the last N hours.

Common commands:
```
python3 scripts/uk_air_sos/uk_air_sos_ingest.py --discover --backfill-2025
python3 scripts/uk_air_sos/uk_air_sos_ingest.py --refresh-recent --hours 6
```

Writes to:
- `connectors`, `stations`, `timeseries`, `observations`

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
- If `connectors.poll_timeseries_batch_size` is set for the chosen connector, it overrides the default batch size for timeseries discovery.
Stations bbox:
- If `connectors.stations_bbox_supported` is false, the script skips bbox when calling `/stations`.
Timeseries station filter:
- If `connectors.timeseries_station_filter_supported` is false, the script skips station filtering for `/timeseries`.
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
- `--batch-size` (default: 10)
- `--update-stations` to run `uk_aq_refresh_station_la_codes`.

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### `scripts/uk_aq_load_pcon_boundaries.py`
Purpose:
- Load Parliamentary Constituency boundary GeoJSON into `pcon_boundaries`.
- Optional: update `stations.pcon_code` + `stations.pcon_version` using the stored boundaries.

Common commands:
```
python3 scripts/uk_aq_load_pcon_boundaries.py --geojson data/pcon.geojson --pcon-version 2024
python3 scripts/uk_aq_load_pcon_boundaries.py --geojson data/pcon.geojson --pcon-version 2024 --update-stations
python3 scripts/uk_aq_load_pcon_boundaries.py --geojson data/pcon.geojson --pcon-version 2024 --update-history
```

Inputs:
- GeoJSON FeatureCollection with Polygon/MultiPolygon geometries.

Key flags:
- `--code-field` (default: `PCON24CD`, use `pcon_code` for legacy datasets)
- `--name-field` (default: `PCON24NM`, use `pcon_name` for legacy datasets)
- `--batch-size` (default: 10)
- `--sleep-seconds` (default: 0.2) pause between batches.
- `--max-retries` (default: 3) retries per batch.
- `--retry-backoff-seconds` (default: 2.0) base backoff between retries.
- `--history-partitions` (default: 1) split history updates into partitions.
- `--history-partition-index` run a single history partition (0-based).
- `--stations-partitions` (default: 1) split station updates into partitions (uses `uk_aq_refresh_station_pcon_codes_partition`).
- `--stations-partition-index` run a single station partition (0-based).
- `--skip-boundaries` to skip uploads and only run update flags.
- `--update-stations` to run `uk_aq_refresh_station_pcon_codes`.
- `--update-history` to run `uk_aq_refresh_station_pcon_history`.

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### `scripts/uk_aq_load_guidelines.py`
Purpose:
- Load WHO GAQG 2021 guideline limits into `uk_aq_guidelines`.

Common commands:
```
python3 scripts/uk_aq_load_guidelines.py
python3 scripts/uk_aq_load_guidelines.py --csv data/WHO-guidelines/WHO_GAQG_2021_pollutant_limits.csv
```

Inputs:
- CSV with columns: pollutant, averaging_time, unit, AQG_2021, IT1, IT2, IT3, IT4, notes, source.

Key flags:
- `--source` to override the CSV source column value for all rows.
- `--batch-size` (default: 200)

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### `scripts/uk_aq_fix_station_geometry.py`
Purpose:
- Fix swapped station geometry coordinates (lat/lon reversed).

Common commands:
```
python3 scripts/uk_aq_fix_station_geometry.py
```

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### `scripts/uk_aq_enrich_station_names.py`
Purpose:
- Preview OSNI Gazetteer place-name matches for stations missing `station_name`.
 - Optionally backfill `stations.region` using OS Open Names GB lookups.

Common commands:
```
python3 scripts/uk_aq_enrich_station_names.py --matches 5
```

Inputs:
- GeoJSON point files:
  - Placenames (default: `data/geojson/OSNI/osni_open_data_-_gazetteer_-_place_names.geojson`).
  - Streetnames (default: `data/geojson/OSNI/osni_open_data_-_gazetteer_-_streetnames.geojson`).
- Optional GB GPKG: `data/gpkg/OS/os_open_names_gpkg/Data/opname_gb.gpkg` (downloaded from Dropbox if missing and a Dropbox path is provided).
  - If the GPKG CRS is not EPSG:4326, install `pyproj` so the script can project station coordinates.

Key flags:
- `--limit` number of stations to inspect (0 means no limit).
- `--matches` number of nearby names to list per station.
- `--max-distance-m` optional maximum distance in meters.
- `--streetnames-geojson` override streetnames GeoJSON path.
- `--no-ni-filter` to also attempt OSNI matching for non-NI stations (debugging only).
- `--apply` update `stations.station_name` for rows with proposed names.
- `--apply` also updates `stations.region` when a GB match provides a region and the station is missing one.
- `--apply-batch-size` batch size for station_name updates (default: 200).

### `scripts/uk_aq_backfill_station_regions.py`
Purpose:
- Backfill `stations.region` using OS Open Names GB lookups for stations missing a region.

Common commands:
```
python3 scripts/uk_aq_backfill_station_regions.py
python3 scripts/uk_aq_backfill_station_regions.py --apply
```

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- Optional Dropbox credentials if `--download-gb-gpkg` is used.

### `scripts/uk_aq_enrich_test_script.py`
Purpose:
- Debug the Supabase REST counts used to decide whether enrichment runs.

Common commands:
```
python3 scripts/uk_aq_enrich_test_script.py
python3 scripts/uk_aq_enrich_test_script.py --samples 10 --verbose
```

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `--page-size` Supabase pagination batch size.
- `--gb-gpkg-path` local path for the OS Open Names GB GeoPackage.
- `--gb-gpkg-dropbox-path` Dropbox path for the GB GPKG (defaults to `UK_AQ_OS_OPEN_NAMES_GB_DROPBOX_PATH` or the local path).
- `--download-gb-gpkg` download the GB GPKG from Dropbox if missing (also auto-downloads when a Dropbox path is set).
- `--include-gb`/`--no-include-gb` include GB stations using OS Open Names lookups (default: on).
- `--gb-search-radius-m` search radius for OS Open Names in meters (default: 5000).
  - GB matches are split into place/street/other based on `local_type`.
  - Place matches also use `populated_place` (fallback to district/borough).
  - GB lookups now scan all candidates within the search radius to find the nearest street.
  - When no GB street matches are found, the closest `gb_other_matches` entry is used for the proposed name.
  - Postcode fallbacks keep their original casing.
- `--include-pollutants` to include pollutant names per station (timeseries/phenomena lookup).
- `--include-latest` to include latest observations per station by phenomenon.
- `--output-format` set to `summary` (default, JSON lines) or `json` (full payload).
  - NI matches use `ni_place_matches`/`ni_street_matches` to avoid confusion with GB matches.

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `UK_AQ_OS_OPEN_NAMES_GB_DROPBOX_PATH` (optional Dropbox path for the GB GPKG).
- `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` (needed if a Dropbox download is triggered).
- `PYPROJ_NETWORK` (optional; set to `ON` if pyproj needs to download grid data).

### `scripts/uk_aq_enrich_station_names_report.py`
Purpose:
- Write station name enrichment results to JSON files for review.

Outputs:
- `station_names_proposed_YYYYMMDD_HHMMSS.json` (summary for every station with `station_name` null).
- `station_names_missing_YYYYMMDD_HHMMSS.json` (detailed payloads where `proposed_station_name` is null, including match lists and a missing summary).

Common commands:
```
python3 scripts/uk_aq_enrich_station_names_report.py
python3 scripts/uk_aq_enrich_station_names_report.py --limit 50 --matches 10
```

Notes:
- Uses the same enrichment logic as `scripts/uk_aq_enrich_station_names.py` so changes there apply here.
- Always includes pollutants and latest observation details in the outputs.

### `scripts/uk_aq_backfill_timeseries_stations.py`
Purpose:
- Backfill timeseries rows missing station/feature mappings by re-querying SOS metadata.

Common commands:
```
python3 scripts/uk_aq_backfill_timeseries_stations.py
python3 scripts/uk_aq_backfill_timeseries_stations.py --connector-code uk_air_sos --service-ref 1
```

Key flags:
- `--connector-id` or `--connector-code` to scope the backfill.
- `--service-ref` to scope to a specific SOS service within the connector.
- `--batch-size` (default: 200)
- `--limit` to cap total rows processed.
- `--sleep-seconds` (default: 0.2) between API calls.

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### `scripts/uk_air_sos/uk_air_sos_list_stations.py`
Purpose:
- Fetch all current stations from UK-AIR SOS.
- Filter to UK bounding box (keeps stations with missing coordinates; `geometry` will be null in Supabase).
- Optional upsert into Supabase.

Common commands:
```
python3 scripts/uk_air_sos/uk_air_sos_list_stations.py
python3 scripts/uk_air_sos/uk_air_sos_list_stations.py --format csv --output uk_stations.csv
python3 scripts/uk_air_sos/uk_air_sos_list_stations.py --to-supabase
python3 scripts/uk_air_sos/uk_air_sos_list_stations.py --no-filter --output uk_aq_stations_all.json
python3 scripts/uk_air_sos/uk_air_sos_list_stations.py --raw-output uk_aq_stations_raw.json
python3 scripts/uk_air_sos/uk_air_sos_list_stations.py --service-id-from-timeseries
```

Default outputs:
- `uk_air_sos_stations.json`
- `uk_aq_stations_all.json` (when using `--no-filter`)
Optional raw output:
- `--raw-output` writes raw station payloads to a separate JSON file.
Service refs:
- By default, if the SOS reports a single service, that service ref is applied to stations in the JSON output.
- The JSON output also includes a top-level `service_ref` when a single service is detected.
- Use `--service-ref-from-timeseries` (alias `--service-id-from-timeseries`) to resolve `service_ref` from timeseries metadata.
- The internal attribute is named `service_ref_from_timeseries` to match the `_ref` convention; the legacy flag name still works for compatibility.

Notes:
- When `--to-supabase` is enabled, station-name backfills include the existing station metadata needed to satisfy NOT NULL constraints.

Writes to (when `--to-supabase` is set):
- `connectors`, `stations`
- `phenomena`, `procedures`, `offerings` (unless `--skip-metadata` is used)
  - `stations` lifecycle fields: `first_seen_at`, `last_seen_at`, `removed_at`
  - Stations not seen in the current run are marked with `removed_at`.

### `scripts/uk_aq_export_stations_dropbox.py`
Purpose:
- Export a combined stations snapshot from Supabase and upload it to Dropbox.

Output:
- `uk_aq_stations_<timestamp>.json` uploaded to the Dropbox folder (default `uk_aq_stations`).

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`
- `UK_AQ_STATIONS_DROPBOX_DIR` (optional)

### `scripts/sensorcommunity/sensorcommunity_list_stations.py`
Purpose:
- Fetch all current Sensor.Community stations for `SCOMM_COUNTRY` (default `GB`).
- Filter to UK bounding box (keeps stations with missing coordinates; `geometry` will be null in Supabase).
- Optional upsert into Supabase.

Common commands:
```
python3 scripts/sensorcommunity/sensorcommunity_list_stations.py
python3 scripts/sensorcommunity/sensorcommunity_list_stations.py --format csv --output uk_sensorcommunity_stations.csv
python3 scripts/sensorcommunity/sensorcommunity_list_stations.py --to-supabase
```

Writes to (when `--to-supabase` is set):
- `connectors`, `stations`
Notes:
- Uses `SCOMM_SERVICE_REF` (defaults to `SCOMM_CONNECTOR_CODE`) for `stations.service_ref`.
- Sets `stations.station_exposure` to `indoor`/`outdoor` when `location.indoor` is present.

### `scripts/sensorcommunity/sensorcommunity_ingest.py`
Purpose:
- Fetch recent Sensor.Community values for `SCOMM_COUNTRY` (default `GB`).
- Upsert connector + station metadata.
- Insert latest observations for PM10 and PM2.5.

Common commands:
```
python3 scripts/sensorcommunity/sensorcommunity_ingest.py --refresh-recent
python3 scripts/sensorcommunity/sensorcommunity_ingest.py --refresh-recent --raw-output sensorcommunity_raw.json
python3 scripts/sensorcommunity/sensorcommunity_ingest.py --refresh-recent --raw-dropbox
```

Writes to:
- `connectors`, `stations`, `timeseries`, `observations`
Notes:
- Uses `SCOMM_SERVICE_REF` (defaults to `SCOMM_CONNECTOR_CODE`) for `stations.service_ref` and `timeseries.service_ref`.
- Ensures `phenomena` rows for `pm10`/`pm2.5` and sets `timeseries.phenomenon_id`.
- When `SCOMM_INGEST_MET_FIELDS=true`, also ingests `temperature`, `humidity`, and `pressure`.
- `SCOMM_FILE_LOG_LEVEL` controls file log verbosity when raw Dropbox capture is enabled.
- Raw Dropbox uploads are gated by `SCOMM_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (or `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`).
- Dropbox credentials required: `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`.
- Optional folders: `SCOMM_RAW_DROPBOX_FOLDER`/`SCOMM_ERROR_DROPBOX_FOLDER` (fallback to `UK_AIR_*`).
- Sets `stations.station_exposure` to `indoor`/`outdoor` when `location.indoor` is present.

### `scripts/uk_air_sos/uk_air_sos_compare.py`
Purpose:
- Fetch DEFRA last-hour readings for a station.
- Compare DEFRA values to the latest Supabase observations for the same station.
- Exit non-zero when mismatches exceed the configured tolerance.

Common commands:
```
python3 scripts/uk_air_sos/uk_air_sos_compare.py
python3 scripts/uk_air_sos/uk_air_sos_compare.py --station-id BR11 --tolerance 1.5
python3 scripts/uk_air_sos/uk_air_sos_compare.py --defra-url "https://uk-air.defra.gov.uk/data/site-data?f_site_id=BR11&view=last_hour"
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

### `scripts/gov_uk_waqn/gov_uk_waqn_ingest.py`
Purpose:
- Placeholder for the Wales Air Quality Network ingest pipeline.

Common commands:
```
python3 scripts/gov_uk_waqn/gov_uk_waqn_ingest.py
```

### `scripts/gov_uk_waqn/gov_uk_waqn_list_stations.py`
Purpose:
- Placeholder for the Wales Air Quality Network station listing.

Common commands:
```
python3 scripts/gov_uk_waqn/gov_uk_waqn_list_stations.py
```

### `scripts/gov_uk_laqn/gov_uk_laqn_ingest.py`
Purpose:
- Placeholder for the London Air Quality Network ingest pipeline.

Common commands:
```
python3 scripts/gov_uk_laqn/gov_uk_laqn_ingest.py
```

### `scripts/gov_uk_laqn/gov_uk_laqn_list_stations.py`
Purpose:
- Placeholder for the London Air Quality Network station listing.

Common commands:
```
python3 scripts/gov_uk_laqn/gov_uk_laqn_list_stations.py
```

### `scripts/breathelondon/breathelondon_ingest.py`
Purpose:
- Placeholder for the Breathe London ingest pipeline.

Common commands:
```
python3 scripts/breathelondon/breathelondon_ingest.py
```

### `scripts/breathelondon/breathelondon_list_stations.py`
Purpose:
- Placeholder for the Breathe London station listing.

Common commands:
```
python3 scripts/breathelondon/breathelondon_list_stations.py
```

## SOS metadata glossary
- `phenomenon`: The observed property (pollutant/parameter), e.g., NO2, O3, PM2.5.
- `procedure`: The sensor or measurement method used to produce the observation.
- `offering`: A logical grouping of observations, often representing a dataset or station-level collection.

## Keys
- `stations` uses bigint `id` with `station_ref` for upstream identifiers (unique by `connector_id, service_ref, station_ref`).
- `timeseries` uses bigint `id` with `timeseries_ref` for upstream identifiers (unique by `connector_id, service_ref, timeseries_ref`).
- `observations` references `timeseries.id` (bigint) and uses `(timeseries_id, observed_at)` as the primary key.
- External identifiers that arrive as text (even if numeric) use `*_ref`; internal joins always use bigint `*_id`.
