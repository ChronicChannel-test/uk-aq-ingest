# AirGradient Network

AirGradient is a non-SOS network handled via the `airgradient` connector and
polled by the Supabase edge function `ingest_airgradient`. The connector uses
AirGradient's public API to list locations and pull recent measurements for each
location before normalizing them into `stations`, `timeseries`, and
`observations`.【F:supabase/functions/ingest_airgradient/index.ts†L1-L624】

## Connector details
- Connector code: `airgradient`
- Service label: `AirGradient`
- Stations are sourced from the AirGradient locations endpoint (configurable via
  `AIRGRADIENT_LOCATIONS_PATH`).【F:supabase/functions/ingest_airgradient/index.ts†L35-L78】

## Environment variables
- `AIRGRADIENT_BASE_URL` (defaults to `https://api.airgradient.com/public/api/v1`)
- `AIRGRADIENT_API_KEY` (required; use the place access token)
- `AIRGRADIENT_CONNECTOR_CODE` (optional; defaults to `airgradient`)
- `AIRGRADIENT_SERVICE_REF` (optional; defaults to `AIRGRADIENT_CONNECTOR_CODE`)
- `AIRGRADIENT_SERVICE_LABEL` (optional; defaults to `AirGradient`)
- `AIRGRADIENT_LOCATIONS_PATH` (optional; defaults to `/locations/measures/current`)
- `AIRGRADIENT_MEASUREMENTS_PATH_TEMPLATE` (optional; defaults to `/locations/{location_id}/measures/current`)
- `AIRGRADIENT_API_KEY_PARAM` (optional; defaults to `token`)
- `AIRGRADIENT_API_KEY_HEADER` (optional; defaults to empty)【F:supabase/functions/ingest_airgradient/index.ts†L35-L78】

## Polling/dispatch
The dispatcher (`uk_aq_dispatch_polls`) triggers `ingest_airgradient` and passes
`window_hours` based on the connector polling configuration. By default, it
polls every 15 minutes with a 1-hour window when `poll_enabled=true`.【F:supabase/functions/uk_aq_dispatch_polls/index.ts†L41-L110】【F:supabase/functions/uk_aq_dispatch_polls/index.ts†L842-L893】
The ingest function requires the connector row to exist (created by the stations
sync) and does not create connector records.

## Measurements
The edge function maps common AirGradient measurement fields to AQ phenomena
(PM1/PM2.5/PM10, CO2, temperature, humidity) and updates `timeseries` with the
latest values. Additional fields can be added in the edge function map if the
API exposes new pollutants.【F:supabase/functions/ingest_airgradient/index.ts†L52-L324】
