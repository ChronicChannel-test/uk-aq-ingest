# uk_aq_networks

Curated catalog of UK-AQ networks used for UI display and edge function lookups.

## Fields
- id: Internal primary key.
- network_code: Canonical network identifier (e.g., `laqn`, `gov_uk_aurn`).
- display_name: UI-friendly network name.
- connector_code: Source connector code (use `uk_air_sos` for SOS-derived networks).
- is_active: Whether the network is active (default true).
- created_at: Row creation timestamp.

## Notes
- `network_code` is unique and should align with `station_network_memberships.network_code`.
- Use `connector_code` to group networks by source when building UI/API responses.
- Seed values live in `supabase/uk_aq_networks_seed.sql`.
