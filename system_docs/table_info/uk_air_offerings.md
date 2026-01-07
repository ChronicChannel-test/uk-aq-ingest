# offerings

Logical groupings for series within a service (as exposed by the SOS API).

## Fields
- id: Internal bigint primary key (generated identity).
- offering_ref: External offering identifier (string).
- label: Human-readable offering name.
- service_id: FK to `services.id`.

## Notes
- Uniqueness is enforced on (service_id, offering_ref).
