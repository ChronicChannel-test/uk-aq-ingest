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
- `OPENAQ_BASE_URL` (optional; defaults to `https://api.openaq.org/v3`)
- `OPENAQ_API_KEY` (required; OpenAQ API key)
- `OPENAQ_CONNECTOR_CODE` (optional; defaults to `openaq`)
- `OPENAQ_SERVICE_REF` (optional; defaults to `OPENAQ_CONNECTOR_CODE`)
- `OPENAQ_SERVICE_LABEL` (optional; defaults to `OpenAQ`)
- `OPENAQ_USER_AGENT` (optional; defaults to `uk-air-quality-networks`)
- `OPENAQ_BBOX` (optional; defaults to `-8.623555,49.863222,1.763337,60.871222`)
- `OPENAQ_PAGE_LIMIT` (optional; defaults to `1000`)
- `OPENAQ_MAX_PAGES` (optional; defaults to `0` meaning no cap)
- `OPENAQ_LOG_LEVEL` (optional; defaults to `INFO`)
- `OPENAQ_LOG_LEVEL` (optional; defaults to `INFO`)

## Scripts

### `scripts/uk_aq_supabase.py`
Purpose:
- Central helper for Supabase clients that target `uk_aq_core`, `uk_aq_raw`, and `uk_aq_pop`.
- Provides `create_supabase_client` plus `SupabaseSchemas` / `SchemaClient` wrappers for schema-specific `.table()` and `.rpc()` calls.

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_KEY` fallback)
- `UK_AQ_CORE_SCHEMA` (optional; defaults to `uk_aq_core`)
- `UK_AQ_RAW_SCHEMA` (optional; defaults to `uk_aq_raw`)
- `UK_AQ_POP_SCHEMA` (optional; defaults to `uk_aq_pop`)

### `scripts/uk_aq_inject_project_ref.mjs`
Purpose:
- Replace Supabase placeholders in web assets during GitHub Actions deploys.

Placeholders:
- `__SUPABASE_PROJECT_REF__` or `{{SUPABASE_PROJECT_REF}}`
- `__SUPABASE_PUBLISHABLE_DEFAULT_KEY__` or `{{SUPABASE_PUBLISHABLE_DEFAULT_KEY}}`
- `__SB_ANON_JWT__` or `{{SB_ANON_JWT}}`

Notes:
- If no placeholders are found, the script exits without changes.
- Optional: `UK_AQ_INJECT_PATHS` (comma-separated file paths) to limit which files are scanned.

Environment:
- `SUPABASE_PROJECT_REF`
- `SUPABASE_PUBLISHABLE_DEFAULT_KEY`
- `SB_ANON_JWT`

### `scripts/uk_aq_export_connectors_snapshot.py`
Purpose:
- Export connector polling settings and station/timeseries counts to a CSV for spreadsheet review.

Common commands:
```
python3 scripts/uk_aq_export_connectors_snapshot.py
python3 scripts/uk_aq_export_connectors_snapshot.py --output network_info/uk_aq/uk_aq_connectors_snapshot.csv
```

Notes:
- Output includes `hours_since_*` fields derived from connector `last_polled_at` / `last_run_end` and timeseries `last_value_at`.

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### `scripts/uk_aq_dashboard_local.py`
Purpose:
- Run a local dashboard server that exposes PM2.5, PM10, and NO2 freshness buckets (timeseries last_value_at).

Common commands:
```
python3 scripts/uk_aq_dashboard_local.py --port 8045
```

Notes:
- Serves the UI at `http://127.0.0.1:8045` and JSON at `/api/dashboard`.
- The HTML lives at `data/uk_aq_dashboard/uk_aq_dashboard.html`.

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

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
- `--raw-dropbox-folder /connectors/uk_air_sos/raw_data` to override the Dropbox folder
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
- Uploads are organized under `connectors/uk_air_sos/raw_data/YYYY-MM-DD` within the configured Dropbox folder (for scoped apps, do not include `/Apps/<app>` in the path).
- Each run also uploads a log file to `/connectors/uk_air_sos/log/YYYY-MM-DD/` (Dropbox app root).
- Logs older than 31 days are zipped into `/connectors/uk_air_sos/log/archive/YYYY-MM-DD.zip`; archive files older than 1 year are removed.
- If `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL` is unset in live environments, the upload never runs (even if `--raw-dropbox` is passed).

### `scripts/erg_laqn/erg_laqn_list_stations.py`
Purpose:
- Fetch LAQN monitoring sites from the ERG AirQuality API.
- Optionally upsert LAQN stations, station_metadata, and seed timeseries rows into Supabase.

Common commands:
```
python3 scripts/erg_laqn/erg_laqn_list_stations.py
python3 scripts/erg_laqn/erg_laqn_list_stations.py --format csv --output laqn_stations.csv
python3 scripts/erg_laqn/erg_laqn_list_stations.py --to-supabase
```

Key flags:
- `--group` to override the GroupName filter (default: London).
- `--no-filter` to skip UK bounding box filtering.
- `--skip-station-metadata` to avoid station_metadata updates.
- `--skip-timeseries` to avoid seeding timeseries rows for each station/species.

Notes:
- Connector upserts preserve existing `poll_enabled`; new connectors default to `poll_enabled=false`.

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `LAQN_BASE_URL` (optional; defaults to `https://api.erg.ic.ac.uk/AirQuality`)
- `LAQN_DEFAULT_GROUP` (optional; defaults to `London`)
- `LAQN_MONITORING_SITES_PATHS` (optional; comma-separated API paths to try)
- `LAQN_CONNECTOR_CODE` (optional; defaults to `erg_laqn`)
- `LAQN_CONNECTOR_LABEL` (optional; defaults to `ERG London Air`, falls back to `LAQN_SERVICE_LABEL`)
- `LAQN_CONNECTOR_DISPLAY_NAME` (optional; defaults to `London Air LAQN`)
- `LAQN_SERVICE_REF` (optional; defaults to `LAQN_CONNECTOR_CODE`)
- `LAQN_USER_AGENT` (optional)
- `LAQN_TIMESERIES_SPECIES` (optional; defaults to `NO2,PM10,PM25,O3`)

### `scripts/openaq/openaq_list_stations.py`
Purpose:
- Fetch OpenAQ locations within the UK bounding box and optionally upsert stations into Supabase.

Common commands:
```
python3 scripts/openaq/openaq_list_stations.py
python3 scripts/openaq/openaq_list_stations.py --format csv --output uk_openaq_stations.csv
python3 scripts/openaq/openaq_list_stations.py --to-supabase
```

Notes:
- Connector upserts preserve existing `poll_enabled`; new connectors default to `poll_enabled=false`.

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DB_URL` (required when using `--to-supabase`)
- `OPENAQ_BASE_URL` (optional; defaults to `https://api.openaq.org/v3`)
- `OPENAQ_API_KEY` (required)
- `OPENAQ_CONNECTOR_CODE` (optional; defaults to `openaq`)
- `OPENAQ_SERVICE_REF` (optional; defaults to `OPENAQ_CONNECTOR_CODE`)
- `OPENAQ_SERVICE_LABEL` (optional; defaults to `OpenAQ`)
- `OPENAQ_USER_AGENT` (optional; defaults to `uk-air-quality-networks`)
- `OPENAQ_BBOX` (optional; defaults to `-8.623555,49.863222,1.763337,60.871222`)
- `OPENAQ_PAGE_LIMIT` (optional; defaults to `1000`)
- `OPENAQ_MAX_PAGES` (optional; defaults to `0` meaning no cap)
- `OPENAQ_LOG_LEVEL` (optional; defaults to `INFO`)

### `scripts/erg_laqn/erg_laqn_ingest.py`
Purpose:
- Ingest LAQN observations from the ERG AirQuality API into Supabase.

Common commands:
```
python3 scripts/erg_laqn/erg_laqn_ingest.py --species NO2,PM10
python3 scripts/erg_laqn/erg_laqn_ingest.py --days 3 --limit 5 --dry-run
```

Key flags:
- `--species` to set pollutant species codes (default: NO2,PM10,PM25,O3).
- `--days` or `--start-date`/`--end-date` to control the ingest window.
- `--index-days` is not supported by LAQN raw data endpoints; the script logs a warning and uses the date range.
- `--site-codes` to ingest a subset of station refs.
- `--stations-json` to use a local LAQN stations snapshot instead of the live API.
- `--skip-stations` to avoid station upserts.
- `--dry-run` to skip Supabase writes while still fetching observations (outputs use a `timeseries_id` of `0`).
- `--output-raw-responses` to write raw API responses per station/species.

Notes:
- Skips zero-valued observations from the most recent hour so placeholder zeros are not written to the DB.

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `LAQN_BASE_URL` (optional; defaults to `https://api.erg.ic.ac.uk/AirQuality`)
- `LAQN_RAW_DATA_URL_TEMPLATE` (optional; overrides the raw data endpoint URL template)
- `LAQN_CONNECTOR_CODE` (optional; defaults to `erg_laqn`)
- `LAQN_CONNECTOR_LABEL` (optional; defaults to `ERG London Air`, falls back to `LAQN_SERVICE_LABEL`)
- `LAQN_CONNECTOR_DISPLAY_NAME` (optional; defaults to `London Air LAQN`)
- `LAQN_SERVICE_REF` (optional; defaults to `LAQN_CONNECTOR_CODE`)
- `LAQN_USER_AGENT` (optional)

### `scripts/erg_laqn/erg_laqn_latest_check.py`
Purpose:
- Check the latest available LAQN observations for a sample of active sites/species.

Common commands:
```
python3 scripts/erg_laqn/erg_laqn_latest_check.py --days 2 --species NO2,PM10
```

Key flags:
- `--days` lookback window in days (default: 2).
- `--species` comma-separated species list (default: NO2).
- `--max-sites` number of active sites to test (default: 5).
- `--stations-json` path to a stations JSON snapshot (default: `erg_laqn_stations.json`).
- `--base-url` ERG API base URL.
- `--timeout` HTTP timeout in seconds.

Environment:
- `LAQN_BASE_URL` (optional; defaults to `https://api.erg.ic.ac.uk/AirQuality`)
- `LAQN_STATIONS_JSON` (optional; defaults to `erg_laqn_stations.json`)

### `scripts/uk_aq_move_history_observations.sh`
Purpose:
- Move observations older than a cutoff from the main DB into the history DB in batches.

Common commands:
```
CUTOFF_DAYS=14 BATCH_SIZE=50000 ./scripts/uk_aq_move_history_observations.sh
./scripts/uk_aq_move_history_observations.sh --days 21 --batch-size 20000
```

Key flags:
- `--days` cutoff age in days (default: 14).
- `--batch-size` rows per batch (default: 50,000).

Environment:
- `SUPABASE_DB_URL` (main DB)
- `SBASE_HISTORY_DB_URL` (history DB)
- `CUTOFF_DAYS` (optional; default 14)
- `BATCH_SIZE` (optional; default 50,000)

### `scripts/uk_aq_refresh_station_geo_aiven.py`
Purpose:
- Look up PCON + LA codes in an Aiven PostGIS DB and update missing values in `stations`.

Common commands:
```
python3 scripts/uk_aq_refresh_station_geo_aiven.py
python3 scripts/uk_aq_refresh_station_geo_aiven.py --page-size 200 --dry-run
```

Key flags:
- `--page-size` Supabase page size (default: 500).
- `--limit` max stations to process (default: 0 = no limit).
- `--sleep-seconds` sleep between updates (default: 0).
- `--dry-run` log updates without writing.

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PCON_AIVEN_PG_DSN`
- `PCON_VERSION` (optional; defaults to latest in Aiven)
- `LA_VERSION` (optional; defaults to latest in Aiven)

### `scripts/uk_aq_resolve_dropbox_geojson.py`
Purpose:
- Resolve and download a GeoJSON file from Dropbox, selecting the latest version when needed.

Common commands:
```
python3 scripts/uk_aq_resolve_dropbox_geojson.py --dropbox-base "/GeoJSON/PCON" --output tmp/pcon.geojson --env-prefix PCON
```

Key flags:
- `--dropbox-base` folder path to search (optional if `--dropbox-path` is provided).
- `--dropbox-path` direct path to a GeoJSON file.
- `--version` target year/version (optional).
- `--output` local output path (required).
- `--env-prefix` prefix for writing `*_VERSION` + `*_GEOJSON_PATH` into `GITHUB_ENV`.

Environment:
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

### `scripts/uk_aq_load_pcon_boundaries_aiven.py`
Purpose:
- Load PCON GeoJSON boundaries into Aiven PostGIS.

Common commands:
```
python3 scripts/uk_aq_load_pcon_boundaries_aiven.py --geojson tmp/pcon.geojson --pcon-version 2024
```

Key flags:
- `--code-field` GeoJSON property for PCON code (default: `PCON24CD`).
- `--name-field` GeoJSON property for PCON name (default: `PCON24NM`).
- `--skip-if-exists` skip upload if version already exists.

Environment:
- `PCON_AIVEN_PG_DSN`

Note:
- Legacy Supabase boundary loaders moved to `archive/2026-01-25/scripts/`.

### `scripts/uk_aq_load_la_boundaries_aiven.py`
Purpose:
- Load LA GeoJSON boundaries into Aiven PostGIS.

Common commands:
```
python3 scripts/uk_aq_load_la_boundaries_aiven.py --geojson tmp/la.geojson --la-version 2024
```

Key flags:
- `--code-field` GeoJSON property for LA code (default: `la_code`).
- `--name-field` GeoJSON property for LA name (default: `la_name`).
- `--source-srid` SRID of the GeoJSON coordinates (default: 4326; LAD 2025 BGC uses 27700).
- `--skip-if-exists` skip upload if version already exists.

Environment:
- `PCON_AIVEN_PG_DSN`

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

### `scripts/uk_aq_backfill_station_memberships.py`
Purpose:
- Backfill `station_network_memberships` from the UK-AIR monitoring sites register (via `uk_air_sos_site_register` + `uk_air_sos_networks`).
- Store UK-AIR site ids per station in `uk_air_sos_station_refs` for repeatable joins.
- Populate `stations.station_type` with the primary network code (single network or AURN priority).
- Set `station_network_memberships.is_primary` for single-network stations and prioritize AURN.
- Filter memberships by `uk_air_sos_network_pollutants` to align networks with pollutant coverage.
- Use `--source sos` to fall back to SOS stationType values (legacy path).

Common commands:
```
python3 scripts/uk_aq_backfill_station_memberships.py
python3 scripts/uk_aq_backfill_station_memberships.py --service-ref-from-timeseries
python3 scripts/uk_aq_backfill_station_memberships.py --no-filter --limit 500
python3 scripts/uk_aq_backfill_station_memberships.py --source sos
```

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `UK_AIR_SOS_BASE_URL` (optional override)
Notes:
- Uses the latest `uk_air_sos_site_register.snapshot_at` by default; use `--snapshot-at` to target a specific snapshot.
- Adjust match tolerances with `--match-distance-m` and `--match-distance-no-name-m` if needed.
- Ensure `uk_air_sos_network_pollutants` is populated (via `scripts/uk_air_sos/uk_air_sos_site_register.py --load`).

### `scripts/uk_air_sos/uk_air_sos_site_register.py`
Purpose:
- Download the UK-AIR "Search for monitoring sites" CSV (all sites).
- Use the CSV as the authoritative register for site ids, names, coordinates, and network membership.

Common commands:
```
python3 scripts/uk_air_sos/uk_air_sos_site_register.py --search-url "<search url>" --output uk_air_sos_site_register.csv
python3 scripts/uk_air_sos/uk_air_sos_site_register.py --csv-url "<direct csv url>" --output uk_air_sos_site_register.csv
python3 scripts/uk_air_sos/uk_air_sos_site_register.py --search-url "<search url>" --dropbox-upload
python3 scripts/uk_air_sos/uk_air_sos_site_register.py --search-url "<search url>" --dropbox-upload --load
python3 scripts/uk_air_sos/uk_air_sos_site_register.py --load-only --csv-path /path/to/uk-air-search-results.csv
```

Environment:
- `UK_AIR_SOS_SITE_SEARCH_URL` (optional; used when `--search-url` is omitted)
- `UK_AIR_SOS_SITE_SEARCH_USER_AGENT` (optional)
- `UK_AQ_DROPBOX_ROOT` (required for `--dropbox-upload`)
- `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` (required for `--dropbox-upload`)
 - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (required for `--load`/`--load-only`)
Notes:
- The script writes a timestamped filename locally and to Dropbox (e.g., `uk_air_sos_site_register_YYYYMMDDTHHMMSSZ.csv`).
- When `--load` is used, it preserves existing `uk_air_sos_networks.network_display_name` values and upserts `uk_air_sos_network_pollutants`.

### `scripts/uk_air_sos/uk_air_sos_membership_report.py`
Purpose:
- Generate a detailed CSV report for SOS membership backfills (pollutant keys, register networks, allowed/filtered networks, memberships).

Common commands:
```
python3 scripts/uk_air_sos/uk_air_sos_membership_report.py
python3 scripts/uk_air_sos/uk_air_sos_membership_report.py --snapshot-at "<timestamp>"
python3 scripts/uk_air_sos/uk_air_sos_membership_report.py --output network_info/UK-Air-SOS/uk_air_sos_membership_report.csv
```

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Notes:
- Defaults to the latest `uk_air_sos_site_register.snapshot_at`.
- Writes to `network_info/UK-Air-SOS/` with a timestamped filename when `--output` is omitted.


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
python3 scripts/uk_air_sos/uk_air_sos_list_stations.py --check-timeseries-links --check-output uk_air_sos_timeseries_link_check.csv
```

Notes:
- Connector upserts preserve existing `poll_enabled`; new connectors default to `poll_enabled=false`.

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
- Optional flags: `--skip-station-metadata`, `--skip-network-memberships`, `--skip-station-type-backfill`.
- `--check-timeseries-links` compares payload station_ref/timeseries_ref links against Supabase and writes a CSV report (no data is changed).
- Placeholder SOS station refs (e.g., `9999999999`) are skipped from outputs/upserts and flagged in `station_metadata` with `exclude_from_ui=true`.

Writes to (when `--to-supabase` is set):
- `connectors`, `stations`, `station_metadata`, `station_network_memberships`
- `phenomena`, `procedures`, `offerings` (unless `--skip-metadata` is used)

### `scripts/uk_air_sos/uk_air_sos_timeseries_metadata_sample.py`
Purpose:
- Sample SOS timeseries metadata for a small set of stations and highlight matches for keywords (e.g., modelled wind/temp).

Common commands:
```
python3 scripts/uk_air_sos/uk_air_sos_timeseries_metadata_sample.py
python3 scripts/uk_air_sos/uk_air_sos_timeseries_metadata_sample.py --station-limit 50
python3 scripts/uk_air_sos/uk_air_sos_timeseries_metadata_sample.py --match-terms "model,wind,temperature"
python3 scripts/uk_air_sos/uk_air_sos_timeseries_metadata_sample.py --output network_info/UK-Air-SOS/uk_air_sos_timeseries_metadata_sample.json
```

Default output:
- `network_info/UK-Air-SOS/uk_air_sos_timeseries_metadata_sample_<timestamp>.json`
  - `stations` lifecycle fields: `first_seen_at`, `last_seen_at`, `removed_at`
  - Stations not seen in the current run are marked with `removed_at`.

### `scripts/uk_aq_export_stations_dropbox.py`
Purpose:
- Export a combined stations snapshot from Supabase and upload it to Dropbox.

Output:
- `uk_aq_stations_<timestamp>.json` uploaded to the Dropbox folder (default `uk_aq_stations/<YYYY-MM>`).
- `daily_summary.json` uploaded alongside the stations snapshot (connector/network counts + OpenAQ provider counts).

Environment:
- `SUPABASE_DB_URL` (required; direct Postgres connection)
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`
- `UK_AQ_DROPBOX_ROOT`
- `UK_AQ_STATIONS_DROPBOX_DIR` (optional)

Error logging:

- Writes JSON error logs to `error_log/<YYYY-MM-DD>/uk_aq_error_<timestamp>_<uuid>.json`.
- Uploads the error log to Dropbox under `<UK_AQ_DROPBOX_ROOT>/error_log/<YYYY-MM-DD>/` when credentials are available.


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
- Connector upserts preserve existing `poll_enabled`; new connectors default to `poll_enabled=false`.

### `scripts/sensorcommunity/sensorcommunity_ingest.py`
Purpose:
- Fetch recent Sensor.Community values for `SCOMM_COUNTRY` (default `GB`).
- Read connector + upsert station metadata.
- Insert latest observations for PM10 and PM2.5.

Common commands:
```
python3 scripts/sensorcommunity/sensorcommunity_ingest.py --refresh-recent
python3 scripts/sensorcommunity/sensorcommunity_ingest.py --refresh-recent --raw-output sensorcommunity_raw.json
python3 scripts/sensorcommunity/sensorcommunity_ingest.py --refresh-recent --raw-dropbox
```

Writes to:
- `stations`, `timeseries`, `observations`
Notes:
- Uses `SCOMM_SERVICE_REF` (defaults to `SCOMM_CONNECTOR_CODE`) for `stations.service_ref` and `timeseries.service_ref`.
- Ensures `phenomena` rows for `pm10`/`pm2.5` and sets `timeseries.phenomenon_id`.
- When `SCOMM_INGEST_MET_FIELDS=true`, also ingests `temperature`, `humidity`, and `pressure`.
- `SCOMM_FILE_LOG_LEVEL` controls file log verbosity when raw Dropbox capture is enabled.
- Raw Dropbox uploads are gated by `SCOMM_RAW_DROPBOX_ALLOWED_SUPABASE_URL` (or `UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL`).
- Dropbox credentials required: `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`.
- Optional folders: `SCOMM_RAW_DROPBOX_FOLDER` (defaults to `/connectors/sensorcommunity/raw_data`) and
  `SCOMM_ERROR_DROPBOX_FOLDER` (defaults to `/error_log`), with `UK_AIR_*` fallbacks.
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

### `scripts/uk_aq_check_error_logs.py`
Purpose:
- Fetch recent `uk_aq_raw.error_logs` rows for debugging edge-function failures.

Common commands:
```
python3 scripts/uk_aq_check_error_logs.py
python3 scripts/uk_aq_check_error_logs.py --source erg_laqn --since-hours 6 --limit 100
```

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- Optional `UK_AQ_RAW_SCHEMA` (defaults to `uk_aq_raw`)

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

### `scripts/erg_laqn/erg_laqn_ingest.py`
Purpose:
- Ingest ERG LAQN observations into Supabase (station/timeseries/observations).

Common commands:
```
python3 scripts/erg_laqn/erg_laqn_ingest.py
```

### `scripts/erg_laqn/erg_laqn_list_stations.py`
Purpose:
- Fetch LAQN monitoring sites and optionally upsert stations, metadata, and timeseries seeds.

Common commands:
```
python3 scripts/erg_laqn/erg_laqn_list_stations.py
```

### `scripts/erg_laqn/erg_laqn_list_groups.py`
Purpose:
- List available ERG LAQN group names.

Common commands:
```
python3 scripts/erg_laqn/erg_laqn_list_groups.py
python3 scripts/erg_laqn/erg_laqn_list_groups.py --format json
```

Environment:
- `LAQN_BASE_URL` (optional; defaults to `https://api.erg.ic.ac.uk/AirQuality`)
- `LAQN_USER_AGENT` (optional)

### `scripts/breathelondon/breathelondon_ingest.py`
Purpose:
- Ingest Breathe London Communities observations using staged checkpoints in Supabase.
- Pulls IPM25 and INO2 data per site and stores checkpoints in `breathelondon_timeseries_checkpoints`.

Common commands:
```
python3 scripts/breathelondon/breathelondon_ingest.py
python3 scripts/breathelondon/breathelondon_ingest.py --initial-days 30 --window-hours 12
python3 scripts/breathelondon/breathelondon_ingest.py --limit 5 --dry-run
python3 scripts/breathelondon/breathelondon_ingest.py --skip-stations --limit 5 --dry-run --window-hours 1
python3 scripts/breathelondon/breathelondon_ingest.py --limit 5 --dry-run --output-timeseries network_info/breathelondon_timeseries.json --output-observations network_info/breathelondon_observations.json --output-checkpoints network_info/breathelondon_checkpoints.json
python3 scripts/breathelondon/breathelondon_ingest.py --skip-stations --limit 5 --dry-run --ignore-checkpoints --start-date 2026-01-19T01:00:00Z --window-hours 12
python3 scripts/breathelondon/breathelondon_ingest.py --skip-stations --recent-stations --limit 5 --dry-run
```

Environment:
- `BREATHELONDON_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `BREATHELONDON_BASE_URL` (optional override)
- `BREATHELONDON_CONNECTOR_CODE` / `BREATHELONDON_SERVICE_REF` (optional override)
- `BREATHELONDON_SERVICE_LABEL` (optional override)
- `BREATHELONDON_USER_AGENT` (optional override)

Notes:
- `--skip-stations` skips `ListSensors` and loads station refs from Supabase instead.
- `--output-timeseries` / `--output-observations` write JSON snapshots (best paired with `--limit`).
- `--output-checkpoints` writes the checkpoint rows pulled from Supabase.
- `--ignore-checkpoints` forces backfill even when checkpoints already exist (use for dry-run testing).
- `--recent-stations` picks stations with the most recent `timeseries.last_value_at` when used with `--skip-stations` (falls back to `observations` if needed).
- Updates `connectors.last_polled_at` on successful non-dry runs.

### `scripts/breathelondon/breathelondon_batch.py`
Purpose:
- Batch station refs from Supabase and invoke `ingest_breathelondon` per chunk.
- Used by GitHub Actions to avoid edge runtime limits.

Common commands:
```
python3 scripts/breathelondon/breathelondon_batch.py --connector-code breathelondon --batch-size 10 --active-only --skip-stations
```

Environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SB_ANON_JWT` (or `SUPABASE_ANON_KEY`)
- `SB_UK_AQ_CRON_SECRET` (optional)
- `BREATHELONDON_CONNECTOR_CODE` (optional override)
- `BREATHELONDON_SERVICE_REF` (optional override)

Notes:
- `--active-only` honors `station_metadata.attributes.enabled` or `station_metadata.attributes.site_active`.
- `--skip-stations` avoids `ListSensors` and uses the Supabase station list instead.
- Stations are ordered by oldest `breathelondon_timeseries_checkpoints.last_fetch_at` (nulls first).

### `scripts/breathelondon/breathelondon_list_stations.py`
Purpose:
- Fetch Breathe London station metadata and optionally upsert stations + metadata in Supabase.

Common commands:
```
python3 scripts/breathelondon/breathelondon_list_stations.py
python3 scripts/breathelondon/breathelondon_list_stations.py --format csv --output uk_breathelondon_stations.csv
python3 scripts/breathelondon/breathelondon_list_stations.py --to-supabase
```

Environment:
- `BREATHELONDON_API_KEY`
- `SUPABASE_URL` (required for `--to-supabase`)
- `SUPABASE_SERVICE_ROLE_KEY` (required for `--to-supabase`)
- `BREATHELONDON_BASE_URL` (optional override)
- `BREATHELONDON_CONNECTOR_CODE` / `BREATHELONDON_SERVICE_REF` (optional override)
- `BREATHELONDON_SERVICE_LABEL` (optional override)
- `BREATHELONDON_USER_AGENT` (optional override)

Notes:
- Connector upserts preserve existing `poll_enabled`; new connectors default to `poll_enabled=false`.

### `scripts/uk_aq_invoke_edge.py`
Purpose:
- Invoke Supabase Edge Functions (one at a time) for ad-hoc testing.

Common commands:
```
python3 scripts/uk_aq_invoke_edge.py --function ingest_breathelondon --connector-code breathelondon
python3 scripts/uk_aq_invoke_edge.py --function ingest_sensorcommunity --connector-code sensorcommunity --payload '{"dry_run":true}'
python3 scripts/uk_aq_invoke_edge.py --function uk_aq_latest --connector-code breathelondon --method GET --params '{"limit":5}'
```

Environment:
- `SUPABASE_URL`
- `SB_ANON_JWT` (or `SUPABASE_ANON_KEY`)
- `SB_UK_AQ_CRON_SECRET` (required for ingest functions when set in Supabase)

## SOS metadata glossary
- `phenomenon`: The observed property (pollutant/parameter), e.g., NO2, O3, PM2.5.
- `procedure`: The sensor or measurement method used to produce the observation.
- `offering`: A logical grouping of observations, often representing a dataset or station-level collection.

## Keys
- `stations` uses bigint `id` with `station_ref` for upstream identifiers (unique by `connector_id, service_ref, station_ref`).
- `timeseries` uses bigint `id` with `timeseries_ref` for upstream identifiers (unique by `connector_id, service_ref, timeseries_ref`).
- `observations` references `timeseries.id` (bigint) and uses `(connector_id, timeseries_id, observed_at)` as the primary key.
- External identifiers that arrive as text (even if numeric) use `*_ref`; internal joins always use bigint `*_id`.
