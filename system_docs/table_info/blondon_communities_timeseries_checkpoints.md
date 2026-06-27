# blondon_communities_timeseries_checkpoints

Purpose:
- Stores per-station/species history progress for the Breathe London Communities API.

Columns:
- `station_id`: FK to `uk_aq_core.stations.id`; part of the primary key.
- `species`: Communities API species code; part of the primary key.
- `timeseries_id`: nullable FK to `uk_aq_core.timeseries.id`.
- `last_observed_at`: latest observation timestamp processed.
- `last_polled_at`: latest polling attempt timestamp.
- `last_error`: most recent polling error.
- `created_at`, `updated_at`: audit timestamps.

Notes:
- This state is Communities-specific and must not be reused by the future Breathe London Nodes connector.
- The station/timeseries `service_ref` may remain `breathelondon`; it is independent of this connector-specific table name.
