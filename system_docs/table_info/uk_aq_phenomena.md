# phenomena

Defines what is measured (pollutant/parameter) within a connector.

## Fields
- id: Internal bigint primary key (generated identity).
- label: Human-readable phenomenon name.
- eionet_uri: Optional EIONET URI identifier for the phenomenon.
- notation: Optional short code/notation from the source.
- pollutant_label: Optional emissions-inventory pollutant label (from reference list).
- connector_id: FK to `connectors.id`.

## Notes
- Uniqueness is enforced on (connector_id, eionet_uri).
