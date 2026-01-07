# categories

High-level grouping of phenomena or stations within a service.

## Fields
- id: Internal bigint primary key (generated identity).
- category_ref: External category identifier (string).
- label: Human-readable category name.
- service_id: FK to `services.id`.

## Notes
- Uniqueness is enforced on (service_id, category_ref).
