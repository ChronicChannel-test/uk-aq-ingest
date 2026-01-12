# categories

High-level grouping of phenomena or stations within a connector.

## Fields
- id: Internal bigint primary key (generated identity).
- category_ref: External category identifier (string).
- label: Human-readable category name.
- connector_id: FK to `connectors.id`.

## Notes
- Uniqueness is enforced on (connector_id, category_ref).
