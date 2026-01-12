# stations

Monitoring sites within a service, with optional spatial metadata.

## Fields
- id: Internal bigint primary key (generated identity).
- station_ref: External station identifier (string).
- label: Human-readable station name.
- station_name: Cleaned station name (best-effort, pollutant suffix removed).
- station_type: Optional station type/classification from the service.
- region: Optional region name from the service.
- geometry: Optional Point geometry (WGS84, SRID 4326).
- service_id: FK to `services.id`.
- category_id: Optional FK to `categories.id`.
- first_seen_at: When the station first appeared in ingest (default now()).
- last_seen_at: Last time the station was confirmed present.
- removed_at: When the station was marked removed (if applicable).
- created_at: Row creation timestamp (default now()).

## Notes
- Uniqueness is enforced on (service_id, station_ref).
- Geometry has a GIST index to support spatial queries.
