# OpenAQ Gap Logic

This document describes how the OpenAQ ingest decides when to enter "gap mode" and how it fetches and records hourly observations when gaps are detected.

## Purpose

Gap mode is used to backfill missing hourly observations for a station when the station appears stale, while keeping request sizes bounded and predictable.

## Key Data Sources

- `uk_aq_raw.openaq_station_checkpoints.last_observed_at`
- `uk_aq_raw.openaq_timeseries_checkpoints.last_observed_at` (per timeseries)
- `uk_aq_core.timeseries.timeseries_ref` (OpenAQ sensor id)
- OpenAQ API: `GET /v3/sensors/{sensor_id}/measurements/hourly`

## Gap Detection

For each station in the run:

1. Read `openaq_timeseries_checkpoints.last_observed_at` for the station's timeseries.
2. If **any** timeseries has `2 hours <= now - last_observed_at < 24 hours`,
   the station is marked `gap_flagged`.
3. Stations with no timeseries checkpoints (or no timestamps) are **not** gap-flagged
   and use the `/latest` endpoint.

## Gap Mode Fetch Window (Chunked)

For each timeseries in a `gap_flagged` station:

- `windowMs` is `window_hours * 60 * 60 * 1000`.
- `datetime_from` is:
  - `openaq_timeseries_checkpoints.last_observed_at` if present, else
  - `openaq_station_checkpoints.last_observed_at` if present, else
  - `now - window_hours`.

- `datetime_to` is capped to a single chunk:
  - `min(now, datetime_from + window_hours)`.

This means each gap-mode request covers at most one `window_hours` chunk.

## Paging and Limits

Hourly endpoint calls are paged (`page`, `limit`).

- Each page is one API request.
- The ingest accumulates pages until:
  - the page returns fewer rows than `limit`, or
  - `OPENAQ_MAX_PAGES` is reached (if set), or
  - rate limit stop is triggered.

The ingest logs paging info (pages, page_limit, record_count) for the debug station and for any request that spans more than one page.

## Missing-Hour Detection (Logging Only)

When `datetime_from` and `datetime_to` are valid:

- Build an expected list of hourly timestamps between those bounds.
- Compare against returned hourly timestamps.
- Log a missing-hours summary when any gaps are detected.

This does not alter data; it is informational for audit/debugging.

## Recording Observations

In gap mode, hourly records are recorded without a "recent-window" filter:

- Gap mode prefers `summary.avg` from the hourly payload for precision, with a fallback
  order of `summary.avg → summary.median → summary.q50 → value` when fields are missing.
- Before change: `recordObservation(..., windowMs)` filtered out rows older than `now - windowMs`.
  - So even if the API returned older hours (e.g., 2026-01-29), they were discarded if
    they were outside "last N hours" relative to now. That made backfill ineffective.
- After change: gap mode calls `recordObservation(..., null)`.
  - This disables the "last N hours" filter, so any hours in the chunk window are
    recorded and upserted, even if they are older than `now - windowHours`.
  - Key point: chunking is enforced by the API `datetime_from`/`datetime_to` bounds.
    The `windowMs` filter was redundant and harmful for backfills.
  - So "removed the window filter" simply means gap mode accepts all returned hourly
    rows, instead of dropping anything older than the recent window.

- Older observations within the chunk are accepted.
- `latestObservedByStationId` and `latestByTimeseriesRef` are updated based on the newest observed_at seen in the chunk.

## Checkpoint Updates

After observations are upserted:

- `openaq_station_checkpoints.last_observed_at` is normally set to the minimum
  observed hour across the station's series.
- If a recent gap is detected (missing hour within the last 24 hours),
  `last_observed_at` is clamped to the last contiguous hour before that gap
  (station-wide min across series).
- `openaq_timeseries_checkpoints.last_observed_at` advances to the latest observed hour seen for each timeseries in the run.
- `observ_interval_samples` can still be updated in gap mode (intervals between observations).
- `ingest_lag_samples` are **not** updated in gap mode (lag is treated as a live-update metric).
- **Gap-mode next_due_at scheduling (stations):**
  - Uses the latest observed timestamp for the station (from the current run if available, otherwise the checkpoint value).
  - If no observed timestamp exists, `next_due_at` is set to `now() - 24 hours` so the station is treated as stale.
  - If latest observed is within the last 24 hours:
    - New observations → `next_due_at = now() + 1 hour`.
    - No new observations → `next_due_at = latest_observed_at` (station can remain stale).
  - If latest observed is older than 24 hours:
    - New observations → `next_due_at = now()` (fast catch-up).
    - No new observations → `next_due_at = latest_observed_at` (station remains stale).

Because gap mode is chunked, multiple runs are required to fully backfill a long gap.

## Practical Implications

- If a gap starts days ago, a single run will only fetch the first `window_hours` chunk.
- To backfill fully, repeat runs until `last_observed_at` reaches the present.
- If paging ever exceeds 1 page, reduce `window_hours` to keep responses small and predictable.

## Related Docs

- `system_docs/openaq.md`
- `system_docs/uk_aq_edge_functions.md`
