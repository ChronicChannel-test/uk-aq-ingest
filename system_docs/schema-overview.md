# UK-AIR Supabase Schema Overview

This document summarizes the schema defined in `supabase/ukair_air_quality_schema.sql` for ingesting UK-AIR SOS / 52°North timeseries data and PM2.5 target tracking.

## Extensions
- `postgis` for spatial columns (geography Point).
- `pgcrypto` for UUID generation (gen_random_uuid).

## Core reference tables
- `services`: SOS instances (id, label, URL, version, type, supports_first_latest, quantities).
- `categories`: high-level grouping, per service.
- `phenomena`: what is measured (pollutant/parameter), per service.
- `offerings`: logical groupings, per service.
- `features`: features of interest with geometry (Point, 4326), per service.
- `procedures`: sensors/methods; optional raw_formats list, per service.
- `stations`: monitoring sites; includes type, region, geometry, links to service/category/phenomenon.

## Timeseries and metadata
- `timeseries`: SOS timeseries metadata (uom, station, service, offering, feature, procedure, phenomenon, category, first/last value, extras, rendering_hints, status_intervals, last_value).
- `reference_values`: optional reference lines attached to a timeseries (name, color, value).

## Observations
- `observations`: raw time-value pairs for each timeseries (observed_at timestamptz, value, status flag). Indexed by (timeseries_id, observed_at).

## PM2.5 target tracking (optional)
- `pm25_population_exposure`: yearly Population Exposure Indicator (PEI) series with deltas and % change vs 2018 baseline.
- `pm25_amct_sites`: annual mean concentration per site/year to track AMCT and interim exceedances.

## RLS (Row Level Security)
- RLS enabled on all domain tables (not on system tables like spatial_ref_sys).
- Policies (idempotent via DO block):
  - `select`: allowed for roles `authenticated` and `service_role`.
  - `all` (insert/update/delete): allowed for `service_role` only.
- Adjust policies if you need anon read or user-owned row scoping.

## Notes on multi-pollutant support
- Schema is pollutant-agnostic: add new phenomena, stations, timeseries, and observations for NO2, O3, PM10, etc. No structural changes needed.

## Minimal ingestion flow
1) Discover metadata from the SOS REST API: services, stations, timeseries (use `expanded=true` for richer fields).
2) Upsert metadata into `services`, `stations`, `timeseries`, and related reference tables.
3) Fetch data via `/timeseries/{id}/getData` (format=tvp) and insert into `observations` (convert epoch ms to timestamptz).
4) Store optional `referenceValues`, `status_intervals`, `rendering_hints`, and `extras` when present.
