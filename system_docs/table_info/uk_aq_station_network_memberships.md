# station_network_memberships

Records network memberships for stations that appear in multiple networks.

## Fields
- station_id: FK to `stations.id`.
- network_code: Network identifier (e.g., `aurn`, `laqn`), FK to `connectors.connector_code`.
- network_label: Optional human-readable network name.
- is_primary: Marks the preferred network for ingest when a station is in multiple networks (default false).
- created_at: Row creation timestamp (default now()).

## Notes
- Primary key is `(station_id, network_code)`.
- Use `is_primary` to drive UI selection when deduplicating stations across networks.
