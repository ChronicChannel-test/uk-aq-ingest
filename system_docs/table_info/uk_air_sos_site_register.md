# uk_air_sos_site_register

Snapshot of the UK-AIR "Search for monitoring sites" CSV.

## Fields
- id: Internal bigint primary key.
- uk_air_id: UK-AIR site identifier from the CSV.
- eu_site_id: EU site identifier (if provided).
- emep_site_id: EMEP identifier (if provided).
- site_name: Site display name.
- environment_type: Site environment type (e.g., urban background).
- zone: UK-AIR zone name.
- start_date: Site start date.
- end_date: Site end date.
- latitude: Latitude (decimal degrees).
- longitude: Longitude (decimal degrees).
- northing: OSGB northing.
- easting: OSGB easting.
- altitude_m: Altitude in meters.
- networks: Array of `network_ref` values from the CSV.
- aurn_pollutants_measured: Pollutants list when provided.
- site_description: Free-text description.
- source_url: Source search URL (optional).
- source_file: Source file name or path (optional).
- snapshot_at: Snapshot timestamp for the CSV run.
- raw_payload: Raw CSV row stored as JSON.
- created_at: Row creation timestamp (default now()).

## Notes
- Unique index on (`uk_air_id`, `snapshot_at`) supports historical snapshots.
- `networks` values map to `uk_air_sos_networks.network_ref`.
