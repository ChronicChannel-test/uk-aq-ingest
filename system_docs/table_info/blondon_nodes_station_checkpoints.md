# blondon_nodes_station_checkpoints

Purpose:
- Stores station-level scheduling state for Breathe London Nodes.

Columns:
- `station_id`: primary key and foreign key to `uk_aq_core.stations.id`.
- `next_due_at`: next scheduled station poll.
- `last_observed_at`: latest successfully written observation across the station.
- `ingest_lag_samples`: recent ingest-lag samples in seconds.
- `last_polled_at`: most recent station polling attempt.
- `last_error`: summary of errors from the most recent station poll.
- `species_last_observed_at`: per-species successful progress as JSONB.
- `species_last_error`: per-species errors as JSONB.
- `created_at`, `updated_at`: audit timestamps.

Scheduling is station-level because `/SensorData` requests are keyed by
`SiteCode` plus species. Per-species progress and errors are stored in JSONB on
the station checkpoint row rather than in a separate per-timeseries checkpoint
table.
