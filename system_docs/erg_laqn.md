# ERG LAQN

Placeholder documentation for the London Air Quality Network (LAQN) sourced from ERG.

## Status
- TODO: capture auth and data model mapping.
- TODO: define ingest and station-listing workflows.

## Endpoints
Source: `network_info/LAQN/Operations at https___api.erg.ic.ac.uk_AirQuality.csv`

- Stations: `/Information/MonitoringSites/GroupName={GroupName}/Json`
- Raw observations: `/Data/SiteSpecies/SiteCode={SiteCode}/SpeciesCode={SpeciesCode}/StartDate={StartDate}/EndDate={EndDate}/Json`
- Raw observations (wide fallback): `/Data/Site/SiteCode={SiteCode}/StartDate={StartDate}/EndDate={EndDate}/Json`

## Payload notes
- Raw observations are returned under `RawAQData.Data` with fields like `@MeasurementDateGMT` and `@Value`.

## Local snapshots
- `scripts/erg_laqn/erg_laqn_ingest.py` supports `--stations-json` for using a local stations snapshot (for example `network_info/LAQN/erg_laqn_stations.json`).
- `--output-raw-responses` writes raw API responses for troubleshooting payload parsing.

## Utilities
- `scripts/erg_laqn/erg_laqn_list_groups.py` lists available ERG group names.
