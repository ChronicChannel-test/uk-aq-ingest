# station_metadata

Supplemental station attributes stored as JSON for network-specific fields that do not belong in `stations`.

## Fields
- station_id: Primary key and FK to `stations.id`.
- attributes: JSON payload containing network-specific metadata (ownership, device details, operational status, siting info, tags).
- created_at: Row creation timestamp (default now()).
- updated_at: Row update timestamp (default now()).

## Notes
- Use a stable key naming convention in `attributes` (e.g., `device_code`, `organisation_name`).
- Time-varying telemetry can live here for latest-state snapshots, but longer history should use observations or a dedicated status table.
