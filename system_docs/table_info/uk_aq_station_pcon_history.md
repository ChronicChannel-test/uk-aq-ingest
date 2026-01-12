# station_pcon_history

Snapshot of station-to-constituency assignments per boundary version.

## Fields
- id: Internal bigint primary key (generated identity).
- station_id: FK to `stations.id`.
- pcon_code: Constituency code (GSS).
- pcon_name: Optional constituency name at that version.
- pcon_version: Boundary dataset version.
- computed_at: Timestamp when the assignment was computed (default now()).

## Notes
- Uniqueness is enforced on (station_id, pcon_version).
- Populated via `uk_aq_refresh_station_pcon_history`.
