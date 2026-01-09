# phenomena

Defines what is measured (pollutant/parameter) within a service.

## Fields
- id: Internal bigint primary key (generated identity).
- label: Human-readable phenomenon name.
- eionet_uri: Optional EIONET URI identifier for the phenomenon.
- notation: Optional short code/notation from the source.
- pollutant_label: Optional emissions-inventory pollutant label (from reference list).
- service_id: FK to `services.id`.

## Notes
- Uniqueness is enforced on (service_id, eionet_uri).
