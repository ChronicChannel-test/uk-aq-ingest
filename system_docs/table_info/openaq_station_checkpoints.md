# openaq_station_checkpoints

Purpose:
- Stores per-station polling state for OpenAQ scheduling.

Columns:
- `station_id`: PK, FK to `uk_aq_core.stations.id`.
- `next_due_at`: next scheduled poll time (timestamptz).
- `last_observed_at`: latest observed timestamp seen for the station (timestamptz).
- `observ_interval_samples`: int[] of recent observed interval samples (seconds).
- `ingest_lag_samples`: int[] of recent ingest lag samples (seconds).
- `last_polled_at`: last time the station was polled (timestamptz).
- `created_at`, `updated_at`: audit timestamps.

Notes:
- Sampling arrays store seconds for precision; scheduler derives minutes via `ceil(seconds / 60)` when setting `next_due_at`.
