# procedures

Sensor or method definitions used by a service.

## Fields
- id: Internal bigint primary key (generated identity).
- procedure_ref: External procedure identifier (string).
- label: Human-readable procedure name.
- raw_formats: Optional list of raw formats supported by the procedure.
- service_id: FK to `services.id`.

## Notes
- Uniqueness is enforced on (service_id, procedure_ref).
