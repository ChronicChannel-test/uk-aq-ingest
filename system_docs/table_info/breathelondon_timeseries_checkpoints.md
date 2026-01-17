# breathelondon_timeseries_checkpoints

Checkpoint table for staged Breathe London data pulls.

Columns:
- station_id: FK to `stations.id`.
- species: API species code (`IPM25`, `INO2`).
- timeseries_id: FK to `timeseries.id` for the station/species.
- last_observed_at: most recent observation timestamp ingested.
- last_fetch_at: last time the API was queried for this station/species.
- last_error: last error message (if any).
- created_at, updated_at: audit timestamps.

Indexes:
- Index on `last_observed_at` for auditing lagging checkpoints.
