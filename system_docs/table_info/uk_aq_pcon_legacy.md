# pcon_legacy

Legacy parliamentary constituency electorate metadata for historical reference.

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
