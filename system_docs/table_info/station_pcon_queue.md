# station_pcon_queue

Queue for throttled PCON lookups.

## Fields
- station_id: FK to `stations.id` (primary key).
- status: Queue state (`pending`, `processing`, `done`).
- attempts: Number of processing attempts.
- last_error: Optional error message from the last attempt.
- created_at: When the station was queued.
- updated_at: Last time the queue row was updated.

## Notes
- Rows are queued when a station has geometry but `pcon_code` is null.
- The worker processes a small batch each run via `uk_aq_process_station_pcon_queue`.
