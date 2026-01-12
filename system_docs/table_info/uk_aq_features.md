# features

Features of interest (spatial entities) referenced by timeseries.

## Fields
- id: Internal bigint primary key (generated identity).
- feature_ref: External feature identifier (string).
- label: Human-readable feature name.
- geometry: Optional Point geometry (WGS84, SRID 4326).
- connector_id: FK to `connectors.id`.
- service_ref: External SOS service identifier (string).

## Notes
- Uniqueness is enforced on (connector_id, service_ref, feature_ref).
- Geometry is stored as PostGIS geography for spatial queries.
