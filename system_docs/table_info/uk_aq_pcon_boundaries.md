# pcon_boundaries

Parliamentary Constituency boundary polygons used for assigning stations to constituencies.

## Fields
- id: Internal bigint primary key (generated identity).
- pcon_code: Constituency code (GSS).
- pcon_name: Optional constituency name.
- pcon_version: Boundary dataset version.
- geometry: MultiPolygon geography (WGS84, SRID 4326).
- created_at: Row creation timestamp (default now()).

## Notes
- Uniqueness is enforced on (pcon_code, pcon_version).
- Geometry has a GIST index to support spatial queries.
- Used by `uk_aq_refresh_station_pcon_codes` and `uk_aq_refresh_station_pcon_history`.
