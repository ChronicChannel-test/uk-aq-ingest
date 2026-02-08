# Feature Fixes

## Geometry fixes
- Test the station geometry workflow from a blank database before promoting to production.

## Timeseries station mapping
- Verify ingest uses label+matching-geometry fallback when station_ref is missing; confirm no ambiguous label matches are applied.
- Applies to `scripts/uk_air_sos/uk_air_sos_ingest.py` and `scripts/uk_aq_backfill_timeseries_stations.py`.
