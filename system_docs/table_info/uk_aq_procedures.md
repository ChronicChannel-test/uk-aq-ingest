# procedures

Sensor or method definitions used by a connector/service_ref.

## Fields
- id: Internal bigint primary key (generated identity).
- procedure_ref: External procedure identifier (string).
- label: Human-readable procedure name.
- raw_formats: Optional list of raw formats supported by the procedure.
- connector_id: FK to `connectors.id`.
- service_ref: External SOS service identifier (string).

## Notes
- Uniqueness is enforced on (connector_id, service_ref, procedure_ref).
