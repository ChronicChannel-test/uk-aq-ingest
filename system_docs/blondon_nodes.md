# Breathe London Nodes ingest

Breathe London Nodes uses connector code `blondon_nodes`, public network/service ref `breathelondon`, and active station rows from `uk_aq_core.stations` where `removed_at is null`.

Observation ingest:
- Script: `scripts/blondon_nodes/blondon_nodes_ingest.py`.
- API endpoint: `GET /SensorData` on `BLONDON_NODES_BASE_URL` (default `https://breathe-london-7x54d7qf.ew.gateway.dev`).
- Required API header: `X-API-KEY: <BLONDON_NODES_API_KEY>` plus JSON accept/content headers.
- Case-sensitive query parameters: `SiteCode`, `Species`, `startTime`, `endTime`.
- Normal runs select due stations using `uk_aq_raw.blondon_nodes_station_checkpoints.next_due_at`.
- Missing station checkpoint rows are due immediately. Manual `--site-code` or `--start-time` runs bypass due filtering.
- Polling start times use per-species progress first, station progress second, then the connector `poll_window_hours` fallback.

Species/timeseries:
- `PM25` -> raw PM2.5 concentration (`ug.m-3`).
- `NO2` -> raw NO2 concentration (`ug.m-3`).
- `PM25Index` -> PM2.5 DAQI/index (`DAQI`).
- `NO2Index` -> NO2 DAQI/index (`DAQI`).
- Timeseries refs use `<SiteCode>:<Species>` so index timeseries stay separate from raw pollutant timeseries.

Write path:
- Upserts `uk_aq_core.phenomena`, `uk_aq_core.timeseries`, and `uk_aq_core.observations`.
- Publishes written rows to the observs Pub/Sub topic (`GCP_OBSERVS_PUBSUB_TOPIC`, default `uk-aq-observs-observations`).
- Publishes latest snapshot requests to `GCP_LATEST_SNAPSHOT_PUBSUB_TOPIC` (default `uk-aq-latest-snapshot-requests`).
- Always writes observations to ingest DB before invoking the additional Observs/obsAQIDB writer.
- Updates `uk_aq_raw.blondon_nodes_station_checkpoints` only after station processing.

Checkpoint scheduling:
- Scheduling is station-level because `/SensorData` requests are keyed by `SiteCode` plus species.
- `species_last_observed_at` and `species_last_error` hold per-species state as JSONB on the station row.
- Observation progress advances only after the ingest DB write succeeds.
- There is no separate per-timeseries checkpoint table for Nodes.

Null/empty handling:
- Rows with `ScaledValue=null` are skipped, counted as `null_values_skipped`, and do not fail the run.
- HTTP 200 with `[]` is treated as a valid empty station/species response and counted as `empty_series`.

`RatificationStatus` is preserved as the observation `status` in the ingest DB
write and in observs delivery. The original field remains in row metadata.
