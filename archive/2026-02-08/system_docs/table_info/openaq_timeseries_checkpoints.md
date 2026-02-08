# openaq_timeseries_checkpoints

Purpose:
- Stores per-timeseries polling state for OpenAQ when using hourly fallback requests.

Columns:
- `station_id`: PK (composite), FK to `uk_aq_core.stations.id`.
- `timeseries_id`: PK (composite), FK to `uk_aq_core.timeseries.id`.
- `next_due_at`: next scheduled poll time (timestamptz).
- `last_observed_at`: latest observed timestamp seen for the timeseries (timestamptz).
- `ingest_lag_samples`: int[] of recent ingest lag samples (seconds).
- `last_polled_at`: last time the timeseries was polled (timestamptz).
- `created_at`, `updated_at`: audit timestamps.

Notes:
- Lag samples store seconds for precision.
- `next_due_at` is set when `last_observed_at` advances or when it is null.
- Uses a 5-minute default lag until at least 10 lag samples exist, then uses the minimum lag.
- Otherwise `next_due_at` is derived from `last_observed_at + 3600s + lag`.
