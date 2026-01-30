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
- `next_due_at` is set whenever `last_observed_at` advances (based on the latest observation).
- Uses a 5-minute default interval until at least 10 interval samples exist, then uses the minimum interval capped at 1 hour.
- Uses a 5-minute default lag until at least 10 lag samples exist, then uses the minimum lag.
- Lag samples are only recorded when a new interval sample is recorded.
- If either interval or lag has fewer than 10 samples, `next_due_at` is set to `now() + 5 minutes`.
- Otherwise `next_due_at` is derived from `last_observed_at + interval + lag`.
- If no observations are returned and `next_due_at` is null, it is set to `now() + 5 minutes`.
