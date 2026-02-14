# UK-AIR SOS Ingest Flow

This page summarizes how SOS data lands in tables and how stations map to multiple networks.

## Key Tables
- `connectors`: data sources. UK-AIR SOS is one connector.
- `stations`: station metadata ingested from SOS (one row per `station_ref`).
- `timeseries`: per-station, per-phenomenon SOS time series metadata (`timeseries_ref`).
- `phenomena`: pollutant definitions tied to a connector.
- `observations`: time/value pairs keyed by `connector_id` + `timeseries_id` + `observed_at`.
- Placeholder SOS station refs (for example `9999999999`) are skipped during ingest and flagged via `station_metadata.exclude_from_ui=true`.
- `uk_air_sos_site_register`: UK-AIR site register snapshot (includes `uk_air_id` + source network labels).
- `uk_air_sos_networks`: network lookup (source label -> internal `network_code` + UI display name).
- `uk_air_sos_network_pollutants`: pollutant matching rules per network.
- `uk_air_sos_station_refs`: map SOS `station_id` to `uk_air_id`.
- `station_network_memberships`: per-station memberships (`network_code`, `is_primary`).

## Ingest Steps
1) **SOS metadata ingest (daily)**
   - Fetches SOS stations + timeseries metadata.
   - Upserts into `stations` and `timeseries`.
   - Each `timeseries` row links to `phenomena` and a `station_id`.
2) **UK-AIR register ingest (daily/periodic)**
   - Loads `uk_air_sos_site_register`.
   - Upserts `uk_air_sos_networks` and `uk_air_sos_network_pollutants`.
3) **Station-to-register matching**
   - If SOS metadata includes a UK-AIR ID, link directly.
   - Otherwise match by station name + distance (coordinates).
   - Writes `uk_air_sos_station_refs` with match method + distance.
4) **Network membership backfill**
   - Collects pollutant keys from station `timeseries` -> `phenomena`.
   - Filters allowed networks via `uk_air_sos_network_pollutants`.
   - Writes `station_network_memberships` (one row per network).

## Polling Flow (Observations)
- 15-minute polling uses `timeseries_ref` to resolve `timeseries.id`.
- Each sample is stored in `observations` keyed by `connector_id` + `timeseries_id` + `observed_at`.
- Edge path: `uk_air_sos_timeseries_checkpoints` records `last_polled_at` so the dispatcher rotates timeseries batches.
- Cloud Run path: `uk_air_sos_station_checkpoints` records station due-state and lag samples; station refs are selected first, then scoped timeseries are polled.

## Why Coordinate Matching Exists
- UK-AIR register is keyed by `uk_air_id`, but SOS metadata does not always include it.
- Station names are not unique and can vary; coordinates are the most stable tie-breaker.
- Name + distance provides a reliable fallback for linking SOS stations to UK-AIR sites.

## Multi-network Stations
- The UK-AIR register lists multiple network labels per `uk_air_id`.
- Memberships are written into `station_network_memberships` as multiple rows per station.
- `network_code` comes from `uk_air_sos_networks`, and `network_label` is the UI name.

## Notes on Station Granularity
- SOS can emit multiple `timeseries_ref` per station.
- We keep `stations` at the SOS `station_ref` level and `timeseries` at the phenomenon level.
- Use `uk_air_sos_station_refs.uk_air_id` to group a station across phenomena or networks.
