# Breathe London

## Source
- Breathe London Communities API.
- API key required for every request (set `BREATHELONDON_API_KEY` in `.env` or Supabase secrets).

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
- Checkpoints live in `breathelondon_station_checkpoints` to avoid re-fetching history.
- Set a modest polling cadence and window sizes to comply with the fair-use terms.
- Connector rows are created by the stations sync; ingests expect the connector to exist and do not create it.

## Field glossary
- `connectors.connector_code`: internal code for the data source (here `breathelondon`).
- `stations.station_ref`: source identifier (SiteCode from Breathe London).
- `stations.label`: raw source label string.
- `stations.station_name`: curated display-friendly name (may be null until set).
- `stations.removed_at`: set when a station is deactivated/removed; `active_only` skips these.
- `station_metadata.attributes.enabled` / `station_metadata.attributes.site_active`: source activity flags; `active_only` treats either truthy value as active.
- `timeseries.timeseries_ref`: internal ref (`<station_ref>:<species>`).
- `timeseries.last_value_at`: timestamp of the most recent observation stored for that timeseries.
- `observations.observed_at`: timestamp of each observation row.
- `breathelondon_station_checkpoints.next_due_at`: next scheduled poll time.
- `breathelondon_station_checkpoints.last_observed_at`: newest observation timestamp successfully fetched for the station.
- `breathelondon_station_checkpoints.ingest_lag_samples`: recent ingest lag samples (seconds).
- `breathelondon_station_checkpoints.last_polled_at`: last time the station was polled.

## Terms highlights
- Attribution required: "Powered by Breathe London Communities" linked to `https://breathelondon-communities.org`.
- Non-commercial use allowed; commercial use requires written approval.
- Use the API fairly; access may be limited if usage is excessive.
- Automated extraction/data mining is not permitted except as expressly allowed by the licence.

## Status
- TODO: define ingest and station-listing workflows.
