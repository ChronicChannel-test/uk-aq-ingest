# error_logs

Centralized error log entries from ingestion and edge functions.

## Fields
- id: UUID primary key (generated).
- created_at: Row creation timestamp (default now()).
- source: Error source identifier (connector, script, function).
- severity: Severity label (e.g., warning, error).
- message: Error message.
- stack: Optional stack trace.
- context: Optional JSON context payload.
- connector_id: Optional FK to `connectors.id`.
- station_id: Optional FK to `stations.id`.
- timeseries_id: Optional FK to `timeseries.id`.
- dropbox_path: Optional Dropbox path for stored artifacts.

## Notes
- FKs use ON DELETE SET NULL to retain logs when related rows are deleted.
- Policies restrict reads/writes to service_role only.
