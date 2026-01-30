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
- Sampling arrays store seconds for precision.
- `next_due_at` is only set when a checkpoint is created.
- Uses a 15-minute default interval until at least 10 interval samples exist, then uses the median interval.
- `next_due_at` is derived from `last_observed_at + interval + median(ingest_lag_samples)`.
- If `next_due_at` is null and no observations are returned, it is set to `now() + 15 minutes`.
