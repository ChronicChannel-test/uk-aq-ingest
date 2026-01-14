# stations

Monitoring sites within a connector/service_ref, with optional spatial metadata.

## Fields
- id: Internal bigint primary key (generated identity).
- station_ref: External station identifier (string).
- label: Human-readable station name.
- station_name: Cleaned station name (best-effort, pollutant suffix removed).
- station_type: Optional station type/classification from the service.
- station_exposure: Optional exposure classification (e.g., indoor/outdoor).
- region: Optional region name from the service.
- la_code: Optional Local Authority GSS code for the station location.
- la_version: Optional Local Authority boundary version used for `la_code`.
- pcon_code: Optional Parliamentary Constituency GSS code for the station location.
- pcon_version: Optional Parliamentary Constituency boundary version used for `pcon_code`.
- geometry: Optional Point geometry (WGS84, SRID 4326).
- connector_id: FK to `connectors.id`.
- service_ref: External SOS service identifier (string).
- category_id: Optional FK to `categories.id`.
- first_seen_at: When the station first appeared in ingest (default now()).
- last_seen_at: Last time the station was confirmed present.
- removed_at: When the station was marked removed (if applicable).
- created_at: Row creation timestamp (default now()).

## Notes
- Uniqueness is enforced on (connector_id, service_ref, station_ref).
- Geometry has a GIST index to support spatial queries.
- For Sensor.Community, `station_exposure` is mapped from `location.indoor` (1 → `indoor`, 0 → `outdoor`; missing stays null).
