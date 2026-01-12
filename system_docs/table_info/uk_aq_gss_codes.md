# gss_codes

Canonical registry of GSS codes across geographies.

## Fields
- id: Internal bigint primary key (generated identity).
- gss_code: GSS code (unique).
- name: Optional geography name.
- geography_type: Optional geography type label.
- valid_from: Optional start date for validity.
- valid_to: Optional end date for validity.

## Notes
- Uniqueness is enforced on gss_code.
