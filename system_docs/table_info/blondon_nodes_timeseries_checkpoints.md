# blondon_nodes_timeseries_checkpoints

Purpose:
- Stores per-station/species history progress for the Breathe London Nodes `/SensorData` API.

Columns:
- `station_id`: FK to `uk_aq_core.stations.id`; part of the primary key.
- `species`: Nodes API species code (`PM25`, `NO2`, `PM25Index`, `NO2Index`); part of the primary key.
- `timeseries_id`: nullable FK to `uk_aq_core.timeseries.id`.
- `last_observed_at`: latest non-null observation timestamp processed.
- `last_polled_at`: latest polling attempt timestamp.
- `last_error`: most recent polling error for the station/species pair.
- `created_at`, `updated_at`: audit timestamps.

Notes:
- This state is connector-specific for `connector_code='blondon_nodes'` and must not be shared with Breathe London Communities.
- Raw pollutant species and DAQI/index species are checkpointed separately because their timeseries refs differ (`<SiteCode>:<Species>`).
