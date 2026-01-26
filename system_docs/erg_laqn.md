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
- EndDate is interpreted as midnight GMT at the start of that date. To include today's data, set `EndDate` to tomorrow's UTC date (`YYYY-MM-DD`).

## Payload notes
- Raw observations are returned under `RawAQData.Data` with fields like `@MeasurementDateGMT` and `@Value`.

## Local snapshots
- `scripts/erg_laqn/erg_laqn_ingest.py` supports `--stations-json` for using a local stations snapshot (for example `network_info/LAQN/erg_laqn_stations.json`).
- `--output-raw-responses` writes raw API responses for troubleshooting payload parsing.
  - If `LAQN_RAW_DATA_URL_TEMPLATE` supplies `EndDate`, it must follow the same "tomorrow" rule to include the current day.

## Dropbox exports
- When `LAQN_CSV_STATION_ID` or `LAQN_CSV_STATION_REF` is set, `ingest_erg_laqn` uploads a daily CSV per pollutant to Dropbox at `/connectors/erg_laqn/` with filename `erg_laqn_{pollutant}_YYYYMMDD.csv`.
- Columns: `station.id,station_ref,label,timeseries_id,value,observed_at`.

## Choosing a CSV station
- Pick a station with recent data (non-null `timeseries.last_value_at`) so the daily CSV has rows.

Example (PM2.5-specific):
```sql
select
  st.id,
  st.station_ref,
  st.label,
  max(ts.last_value_at) as latest_ts
from stations st
join timeseries ts on ts.station_id = st.id
join connectors c on c.id = ts.connector_id
left join phenomena ph on ph.id = ts.phenomenon_id
where c.connector_code = 'erg_laqn'
  and coalesce(lower(ph.pollutant_label), '') in ('pm2.5','pm25')
group by st.id, st.station_ref, st.label
order by latest_ts desc nulls last
limit 10;
```

If `latest_ts` is null, broaden to any pollutant:
```sql
select
  st.id,
  st.station_ref,
  st.label,
  max(ts.last_value_at) as latest_ts
from stations st
join timeseries ts on ts.station_id = st.id
join connectors c on c.id = ts.connector_id
where c.connector_code = 'erg_laqn'
group by st.id, st.station_ref, st.label
order by latest_ts desc nulls last
limit 10;
```

## Utilities
- `scripts/erg_laqn/erg_laqn_list_groups.py` lists available ERG group names.
