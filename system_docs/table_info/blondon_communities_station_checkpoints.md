# blondon_communities_station_checkpoints

Purpose:
- Stores per-station polling state for Breathe London Communities scheduling.

Columns:
- `station_id`: PK, FK to `uk_aq_core.stations.id`.
- `next_due_at`: next scheduled poll time (timestamptz).
- `last_observed_at`: latest observed timestamp seen for the station (timestamptz).
- `ingest_lag_samples`: int[] of recent ingest lag samples (seconds).
- `last_polled_at`: last time the station was polled (timestamptz).
- `created_at`, `updated_at`: audit timestamps.

Notes:
- Lag samples store seconds for precision.
- `next_due_at` is set only when it is null or when `last_observed_at` advances.
- If fewer than 10 lag samples exist, `next_due_at` is set to `now() + 5 minutes`.
- Otherwise `next_due_at` is derived from `last_observed_at + 3600 seconds + min(lag)`.
- If no observations are returned and `next_due_at` is null, it is set to `now() + 5 minutes`.
