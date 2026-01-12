# la_boundaries

Local Authority boundary polygons used for assigning stations to LAs.

## Fields
- id: Internal bigint primary key (generated identity).
- la_code: Local Authority code.
- la_name: Optional Local Authority name.
- la_version: Boundary dataset version.
- geometry: MultiPolygon geography (WGS84, SRID 4326).
- created_at: Row creation timestamp (default now()).

## Notes
- Uniqueness is enforced on (la_code, la_version).
- Geometry has a GIST index to support spatial queries.
- Used by `uk_aq_refresh_station_la_codes` to populate station LA codes.
