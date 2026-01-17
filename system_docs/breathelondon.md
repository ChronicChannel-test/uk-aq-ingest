# Breathe London

## Source
- Breathe London Communities API.
- API key required for every request (set `BREATHELONDON_API_KEY` in `.env` or Supabase secrets).

## Endpoints
- List sensors (metadata):
  - `https://api.breathelondon-communities.org/api/ListSensors?key=yourAPIkey`
- Sensor metadata by SiteCode:
  - `https://api.breathelondon-communities.org/api/Sensor/SiteCode?key=yourAPIkey`
- Timeseries data:
  - `https://api.breathelondon-communities.org/api/getClarityData/<SiteCode>/<Species>/<Start>/<End>/Hourly?key=yourAPIkey`
  - Species: `IPM25` (PM2.5) or `INO2` (NO2)
  - Time format example: `Mon 11 Apr 2022 11:00:00 GMT` (spaces allowed or `%20`)

## Ingest notes
- Observations are pulled per SiteCode and species (`IPM25`, `INO2`) in hourly windows.
- Checkpoints live in `breathelondon_timeseries_checkpoints` to avoid re-fetching history.
- Set a modest polling cadence and window sizes to comply with the fair-use terms.

## Terms highlights
- Attribution required: "Powered by Breathe London Communities" linked to `https://breathelondon-communities.org`.
- Non-commercial use allowed; commercial use requires written approval.
- Use the API fairly; access may be limited if usage is excessive.
- Automated extraction/data mining is not permitted except as expressly allowed by the licence.

## Status
- TODO: define ingest and station-listing workflows.
