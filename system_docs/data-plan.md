# Data Ingestion and Visualization Plan (2025 focus)

## Goals
- Backfill all 2025 measurements via UK-AIR SOS REST API.
- Keep data fresh for map, animation, and line charts.
- Support multi-pollutant (NO2, O3, PM10, PM2.5, etc.) with status flags.

## Ingestion (initial backfill)
1) Discover metadata
- Call `/api/v1/services`, `/stations`, `/timeseries?expanded=true`.
- Persist into `connectors`, `stations`, `timeseries`, plus related reference tables.
2) Select timeseries
- Filter to UK stations and pollutants of interest (NO2, O3, PM10, PM2.5, etc.).
3) Backfill 2025 data
- For each timeseries, request `/timeseries/{id}/getData?timespan=2025-01-01/2026-01-01&format=tvp`.
- If API spans are limited, chunk by month or week.
- Convert epoch ms → timestamptz; store status flags (V/P/N/S).
- Upsert into `observations` keyed by (timeseries_id, observed_at).
4) Handle paging/limits
- Use smaller timespans and retries; respect any rate limits.

## Ongoing updates
- Schedule hourly (or 15-min) incremental pulls via cron/Edge Function.
- Query recent window (e.g., last 6–24h) to cover gaps: `/timeseries/{id}/getData?timespan=PT6H/now`.
- Upsert idempotently; keep `last_value_at` per timeseries for monitoring.
- Alert if no new data for a station beyond a threshold.

## Data quality & enrichment
- Keep status flags; style suspect/not-verified differently.
- Geometry in WGS84 (CRS84) for map use.
- Add pollutant-specific thresholds (e.g., DAQI bands) for consistent coloring.
- For display-only, allow downsampling/generalization; do not overwrite raw.

## Map (colored circles)
- Use station geometry + latest value per pollutant (join `timeseries` → `observations`).
- Color by pollutant thresholds; fade or gray out stale data (>2–3h old).
- Tooltips: station, pollutant, value, unit, status, timestamp.
- Size/opacity can encode recency or magnitude.

## Animation
- Materialize hourly snapshots: “latest per station/pollutant per hour” table/view for the last N days.
- Drive a time slider with these buckets; cache to reduce query load.
- Downsample frames if needed for smooth playback.

## Line charts
- Query by station/pollutant with timespan filters.
- Offer raw vs. generalized (LTTB/DP) options for long ranges.
- Show gaps or breaks for missing/suspect data.
- Add reference lines (limits/targets) via `reference_values`.

## Derived/aggregate views (optional but useful)
- Daily/weekly aggregates per station/pollutant (mean, max) for trends.
- Exceedance counts vs. thresholds and rankings (hotspots / most improved).
- Coverage map: stations by pollutant availability.
- “Latest per station/pollutant” view for fast map reads.

## Scheduling & reliability
- Cron cadence: hourly (or 15 min if allowed), with 1–2h overlap window.
- Rate-limit friendly: stagger requests; batch per pollutant/region.
- Health checks: daily new-points count; alert on drop to zero.

## What to build next (suggested)
- SQL views: latest-per-station/pollutant; hourly snapshots; daily aggregates.
- Ingest script/Edge Function: chunked requests, retries, idempotent upserts.
- Threshold config table (by pollutant) for consistent coloring and exceedance logic.
