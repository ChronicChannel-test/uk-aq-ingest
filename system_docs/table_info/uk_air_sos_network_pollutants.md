# uk_air_sos_network_pollutants

Defines pollutant matching rules for UK-AIR SOS network membership filtering.

## Fields
- network_ref: FK to `uk_air_sos_networks.network_ref` (raw network label from the UK-AIR register).
- match_type: Matching strategy (`contains` or `exact`).
- match_value: Token or label used by the matcher after normalization.
- created_at: Row creation timestamp (default now()).

## Notes
- Match values are compared against normalized pollutant labels derived from `phenomena.pollutant_label`, `phenomena.label`, and `phenomena.notation`.
- Parenthetical qualifiers like `(air)` are stripped before matching.
- Rules are seeded during `scripts/uk_air_sos/uk_air_sos_site_register.py --load`.
- Networks without rules are skipped during `station_network_memberships` backfills.
