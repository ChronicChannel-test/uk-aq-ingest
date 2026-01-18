# station_network_memberships

Records network memberships for stations that appear in multiple networks.

## Fields
- station_id: FK to `stations.id`.
- network_code: Network identifier (e.g., `gov_uk_aurn`, `laqn`), FK to `connectors.connector_code`.
- network_label: Optional human-readable network name (used by UI as the display name; for UK-AIR SOS it is populated from `uk_air_sos_networks.network_display_name`).
- is_primary: Marks the preferred network for ingest when a station is in multiple networks (default false).
- created_at: Row creation timestamp (default now()).

## Notes
- Primary key is `(station_id, network_code)`.
- Use `is_primary` to drive UI selection when deduplicating stations across networks.
- Current usage: only UK-AIR SOS stations populate this table; single-network connectors rely on `connectors.label` as the UI fallback.
- Future multi-network connectors can populate memberships to expose multi-network stations in the UI.
