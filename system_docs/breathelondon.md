# Breathe London

## Source
- Breathe London Communities API.
- API key required for every request (set `BLONDON_COMMUNITIES_API_KEY` in `.env` or Supabase secrets).

## Endpoints
- List sensors (metadata):
  - `https://api.breathelondon-communities.org/api/ListSensors?key=yourAPIkey`
- Sensor metadata by SiteCode:
  - `https://api.breathelondon-communities.org/api/Sensor/SiteCode?key=yourAPIkey`
- Timeseries data:
  - `https://api.breathelondon-communities.org/api/getClarityData/<SiteCode>/<Species>/<Start>/<End>/Hourly?key=yourAPIkey`
  - Species: `IPM25` (PM2.5) or `INO2` (NO2)
  - Time format example: `Mon 11 Apr 2022 11:00:00 GMT` (spaces allowed or `%20`)

## Ingest notes
- Observations are pulled per SiteCode and species (`IPM25`, `INO2`) in hourly windows.
- Scheduling checkpoints live in `blondon_communities_station_checkpoints`.
- Per-species history checkpoints live in `blondon_communities_timeseries_checkpoints`.
- Set a modest polling cadence and window sizes to comply with the fair-use terms.
- Connector rows are created by the stations sync; ingests expect the connector to exist and do not create it.

## Field glossary
- `connectors.connector_code`: internal code for the Communities data source (`blondon_communities`).
- `networks.network_code`: public network code (`breathelondon`).
- `stations.service_ref` / `timeseries.service_ref`: shared Breathe London service-family identifier (`breathelondon`).
- `stations.station_ref`: source identifier (SiteCode from Breathe London).
- `stations.label`: raw source label string.
- `stations.station_name`: curated display-friendly name (may be null until set).
- `stations.removed_at`: set when a station is deactivated/removed; `active_only` skips these.
- `station_metadata.attributes.enabled` / `station_metadata.attributes.site_active`: source activity flags; `active_only` treats either truthy value as active.
- `timeseries.timeseries_ref`: internal ref (`<station_ref>:<species>`).
- `timeseries.last_value_at`: timestamp of the most recent observation stored for that timeseries.
- Phenomenon source labels `breathelondon:pm2.5` and `breathelondon:no2` identify the shared source service and pollutant. They are not connector codes, so they remain stable across Communities and future Nodes connector implementations.
- `observations.observed_at`: timestamp of each observation row.
- `blondon_communities_station_checkpoints.next_due_at`: next scheduled poll time.
- `blondon_communities_station_checkpoints.last_observed_at`: newest observation timestamp successfully fetched for the station.
- `blondon_communities_station_checkpoints.ingest_lag_samples`: recent ingest lag samples (seconds).
- `blondon_communities_station_checkpoints.last_polled_at`: last time the station was polled.
- `blondon_communities_timeseries_checkpoints`: per-station/species history progress for the Communities API.

## Terms highlights
- Attribution required: "Powered by Breathe London Communities" linked to `https://breathelondon-communities.org`.
- Non-commercial use allowed; commercial use requires written approval.
- Use the API fairly; access may be limited if usage is excessive.
- Automated extraction/data mining is not permitted except as expressly allowed by the licence.

## Status
- TODO: define ingest and station-listing workflows.
