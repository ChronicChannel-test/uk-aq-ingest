# erg_laqn_station_checkpoints

Checkpoint table for staged ERG LAQN batch polling.

Columns:
- station_id: FK to `stations.id`.
- last_polled_at: last time the edge function polled this station.
- created_at, updated_at: audit timestamps.

Indexes:
- Index on `last_polled_at` for ordering lagging stations.
