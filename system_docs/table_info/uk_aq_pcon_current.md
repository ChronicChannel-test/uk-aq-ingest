# pcon_current

Current parliamentary constituency electorate metadata.

## Fields
- id: Internal bigint primary key (generated identity).
- gss_code: Constituency GSS code (unique).
- name: Constituency name.
- electorate: Electorate size (integer).
- region: Region name.
- country: Country name.
- created_at: Row creation timestamp (default now()).

## Notes
- Uniqueness is enforced on gss_code.
