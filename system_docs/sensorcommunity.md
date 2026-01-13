# Sensor.Community

This network uses Sensor.Community (formerly Luftdaten) for community air quality sensors.

## Source API
- **Read domain:** `https://data.sensor.community`
- **Endpoint used:** `/airrohr/v1/filter/country=GB`
- **User-Agent:** Set `SCOMM_USER_AGENT` to identify your client (Sensor.Community request guidance).

## Storage mapping
- Connector metadata is stored in `connectors` (ref: `sensorcommunity`).
- Stations are stored in `stations` with `connector_id` and `station_ref` based on the Sensor.Community sensor ID.
- Timeseries are created per station + pollutant (`pm10`, `pm2.5`), using `timeseries_ref` like `{station_ref}:{pollutant}`.
- Observations are inserted into `observations` with the timestamp provided by Sensor.Community payloads.

## Poll cadence
- Intended polling cadence: every 15 minutes at **:10, :25, :40, :55** (UTC).
