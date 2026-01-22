# station_network_memberships

Records network memberships for stations that appear in multiple networks.

## Fields
- station_id: FK to `stations.id`.
- network_code: Network identifier (e.g., `gov_uk_aurn`, `laqn`) mapped from `uk_aq_networks.network_code`.
- network_label: Optional human-readable network name (used by UI as the display name; for UK-AIR SOS it is often populated from `uk_air_sos_networks.network_display_name`).
- is_primary: Marks the preferred network for ingest when a station is in multiple networks (default false).
- created_at: Row creation timestamp (default now()).

## Notes
- Primary key is `(station_id, network_code)`.
- `network_code` has an optional FK to `uk_aq_networks.network_code` (added as NOT VALID; validate after seeding).
- Use `is_primary` to drive UI selection when deduplicating stations across networks.
- SOS-derived memberships are filtered by `uk_air_sos_network_pollutants` so stations only join networks that match their pollutant coverage.
- Current usage: UK-AIR SOS stations populate this table; single-network connectors rely on `uk_aq_networks.display_name` as the UI fallback.
- Other SOS-served networks (e.g., LAQN when exposed via SOS) can also populate memberships.
