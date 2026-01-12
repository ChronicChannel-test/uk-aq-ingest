# pm25_amct_sites

PM2.5 Annual Mean Concentration Target (AMCT) site statistics.

## Fields
- id: Internal bigint primary key (generated identity).
- site_code: Site identifier.
- site_name: Site name.
- year: Year of measurement.
- annual_mean: Annual mean PM2.5 value.
- exceeded_interim: Whether interim target was exceeded.
- exceeded_final: Whether final target was exceeded.
- data_capture_ok: Whether data capture met requirements.
- collected_at: Timestamp of data collection (default now()).

## Notes
- Index supports queries by (site_code, year).
