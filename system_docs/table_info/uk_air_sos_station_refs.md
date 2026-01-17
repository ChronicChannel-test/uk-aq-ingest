# uk_air_sos_station_refs

Lookup table linking `stations` rows to UK-AIR site ids from the monitoring sites register.

Columns:
- station_id: PK, references `stations.id`.
- uk_air_id: UK-AIR site id (e.g., UKA...).
- match_method: how the match was made (e.g., name+distance).
- match_distance_m: distance in meters for coordinate-based matches.
- source_snapshot_at: snapshot timestamp from `uk_air_sos_site_register` used for the match.
- created_at, updated_at: audit timestamps.

Indexes:
- Index on `uk_air_id` for reverse lookups.
- Index on `source_snapshot_at` for auditing matches per register snapshot.
