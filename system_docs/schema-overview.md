# UK-AQ Supabase Schema Overview

This document summarizes the schema defined in `supabase/uk_air_quality_schema.sql` for ingesting UK-AIR SOS / 52°North timeseries data and PM2.5 target tracking.

## Extensions
- `postgis` for spatial columns (geography Point).
- `pgcrypto` for UUID generation (gen_random_uuid).

## Core reference tables
- External identifiers that arrive as text (even if numeric) are stored as `*_ref`; all `*_id` columns are internal bigint keys.
- `connectors`: network connectors with bigint `id` (internal) and `connector_code` for filename prefixes, plus URL and polling fields (`display_name_template`, `overwrite_station_name`, `poll_enabled`, `poll_interval_minutes`, `poll_window_hours`, `poll_timeseries_batch_size`, `stations_bbox_supported`, `timeseries_station_filter_supported`, `last_polled_at`).
- `categories`: high-level grouping, per connector.
- `phenomena`: what is measured (pollutant/parameter), per connector; includes optional `eionet_uri` + `notation`.
- `offerings`: logical groupings, per connector + `service_ref`.
- `features`: features of interest with geometry (Point, 4326), per connector + `service_ref`.
- `procedures`: sensors/methods; optional raw_formats list, per connector + `service_ref`.
- `stations`: monitoring sites; bigint `id` (internal) with `station_ref` (external) and `service_ref` (remote SOS service id), unique `(connector_id, service_ref, station_ref)`, plus lifecycle fields `first_seen_at`, `last_seen_at`, `removed_at`. Includes `station_name` as a cleaned display name, `station_type` as the service-provided classification, `station_exposure` for indoor/outdoor, and stores `la_code`/`la_version` and `pcon_code`/`pcon_version` for geography lookups.
- `station_metadata`: per-station JSON attributes for network-specific fields not stored on `stations` (ownership, device, status, siting metadata).
- `station_network_memberships`: multi-network membership metadata for stations, including a `network_code` (FK to `connectors.connector_code`) and `is_primary` flag for preferred ingest source.

## Geography mapping tables
- `la_boundaries`: Local Authority polygons (MultiPolygon, 4326) with `la_code` + `la_version` for assigning stations to LAs.
- `pcon_boundaries`: Parliamentary Constituency polygons (MultiPolygon, 4326) with `pcon_code` + `pcon_version` for assigning stations to constituencies.
- `station_pcon_history`: Station-to-constituency snapshot per `pcon_version` for fast historical queries.
- `station_pcon_queue`: Throttled queue for PCON lookups (pending stations with geometry + missing PCON).
- Spatial index note: expression GIST indexes on `(geometry::geometry)` for `stations` and `pcon_boundaries` support the `ST_Covers` casts used in queue/history refreshes.
- Lookup index note: partial index on `stations` where `pcon_code` is null helps periodic checks for missing constituency assignments.
- `uk_aq_region_names`: Region code/name lookup (e.g., `E12000001` → `North East`) used for hex metadata.
- `uk_aq_refresh_station_la_codes(target_version)`: updates `stations.la_code` + `stations.la_version` using `la_boundaries`.
- `uk_aq_refresh_station_pcon_codes(target_version)`: updates missing or out-of-date `stations.pcon_code` + `stations.pcon_version` using `pcon_boundaries`.
- `uk_aq_refresh_station_pcon_codes_partition(target_version, partition_mod, partition_idx)`: partitioned station PCON refresh (missing/out-of-date only) for large datasets.
- `uk_aq_refresh_station_pcon_history(target_version)`: populates `station_pcon_history` for a boundary version.
- `uk_aq_refresh_station_pcon_history_partition(target_version, partition_mod, partition_idx)`: partitioned history refresh for large datasets.
- `uk_aq_process_station_pcon_queue(target_version, batch_limit)`: processes a small batch of queued stations with geometry (no `last_value` requirement), updating `stations` and `station_pcon_queue` via spatial coverage checks.
- `uk_aq_stations_with_pcon(target_version)`: returns stations joined to `station_pcon_history` for the requested version.
- `uk_aq_fix_station_geometry_swapped()`: fixes stations with swapped lat/lon coordinates.

## Timeseries and metadata
- `timeseries`: SOS timeseries metadata; bigint `id` (internal) with `timeseries_ref` (external), `service_ref`, and `station_id` bigint FK.
- `reference_values`: optional reference lines attached to a timeseries (name, color, value).

## Observations
- `observations`: raw time-value pairs for each timeseries (observed_at timestamptz, value, status flag). Primary key is `(timeseries_id, observed_at)`.

## PM2.5 target tracking (optional)
- `pm25_population_exposure`: yearly Population Exposure Indicator (PEI) series with deltas and % change vs 2018 baseline.
- `pm25_amct_sites`: annual mean concentration per site/year to track AMCT and interim exceedances.

## Constituency reference tables
- `pcon_current`: current constituency electorate data (`gss_code`, `name`, `electorate`, `region`, `country`).
- `pcon_legacy`: legacy constituency electorate data for historical backfill (same columns as `pcon_current`).
- `gss_codes`: canonical registry of GSS codes across geographies (`gss_code`, `name`, `geography_type`, `valid_from`, `valid_to`).

## Guideline limits
- `uk_aq_guidelines`: pollutant guideline limits (WHO/UK/EU, etc.) with `pollutant`, `averaging_period_label`, `averaging_period_interval`, `level_label`, `limit_value`, `uom`, and optional `source`/`notes`/validity dates.

## Views
- `pcon_latest_pm25` (in `supabase/uk_air_quality_views.sql`): constituency-level PM2.5 summaries keyed by `pcon_code` + `pcon_version` with median/mean, station_count, and last update timestamp.

## RLS (Row Level Security)
- RLS enabled on all domain tables (not on system tables like spatial_ref_sys).
- Policies (idempotent via DO block):
  - `select`: allowed for roles `authenticated` and `service_role`.
  - `all` (insert/update/delete): allowed for `service_role` only.
- Adjust policies if you need anon read or user-owned row scoping.

## Sample queries

Top constituencies by station count (history snapshot):
```sql
select
  pcon_code,
  pcon_name,
  count(*) as station_count
from station_pcon_history
where pcon_version = '2024'
group by pcon_code, pcon_name
order by station_count desc
limit 10;
```

## Notes on multi-pollutant support
- Schema is pollutant-agnostic: add new phenomena, stations, timeseries, and observations for NO2, O3, PM10, etc. No structural changes needed.

## Minimal ingestion flow
1) Discover metadata from the SOS REST API: services, stations, timeseries (use `expanded=true` for richer fields).
2) Upsert metadata into `connectors`, `stations`, `timeseries`, and related reference tables.
3) Fetch data via `/timeseries/{id}/getData` (format=tvp) and insert into `observations` (convert epoch ms to timestamptz).
4) Store optional `referenceValues`, `status_intervals`, `rendering_hints`, and `extras` when present.
