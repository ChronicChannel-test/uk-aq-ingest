# Sensor.Community

This network uses Sensor.Community (formerly Luftdaten) for community air quality sensors.

## Source API
- **Read domain:** `https://data.sensor.community`
- **Endpoint used:** `/airrohr/v1/filter/country=GB`
- **User-Agent:** Set `SCOMM_USER_AGENT` to identify your client (Sensor.Community request guidance).

## Storage mapping
- Connector metadata is stored in `connectors` (`connector_code`: `sensorcommunity`).
- Stations are stored in `stations` with `connector_id`, `service_ref` (defaults to `sensorcommunity`), and `station_ref` based on the Sensor.Community sensor ID.
- Timeseries are created per station + pollutant (`pm10`, `pm2.5`), using `timeseries_ref` like `{station_ref}:{pollutant}` and the same `service_ref`.
- Phenomena rows are created for `pm10` and `pm2.5`, and `timeseries.phenomenon_id` is set accordingly.
- Observations are inserted into `observations` with the timestamp provided by Sensor.Community payloads.

## Poll cadence
- Intended polling cadence: every 15 minutes at **:10, :25, :40, :55** (UTC).

## Logging
- `SCOMM_LOG_LEVEL` controls script verbosity (default: `INFO`).
