# offerings

Logical groupings for series within a connector/service_ref (as exposed by the SOS API).

## Fields
- id: Internal bigint primary key (generated identity).
- offering_ref: External offering identifier (string).
- label: Human-readable offering name.
- connector_id: FK to `connectors.id`.
- service_ref: External SOS service identifier (string).

## Notes
- Uniqueness is enforced on (connector_id, service_ref, offering_ref).
