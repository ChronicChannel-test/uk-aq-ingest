# features

Features of interest (spatial entities) referenced by timeseries.

## Fields
- id: Internal bigint primary key (generated identity).
- feature_ref: External feature identifier (string).
- label: Human-readable feature name.
- geometry: Optional Point geometry (WGS84, SRID 4326).
- service_id: FK to `services.id`.

## Notes
- Uniqueness is enforced on (service_id, feature_ref).
- Geometry is stored as PostGIS geography for spatial queries.
