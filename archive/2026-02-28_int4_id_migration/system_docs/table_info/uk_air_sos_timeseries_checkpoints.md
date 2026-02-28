# uk_air_sos_timeseries_checkpoints

Tracks the last time each UK-AIR SOS timeseries was polled so batches can rotate
even when a station stops sending data.

## Columns
- `timeseries_id` (bigint, PK): Internal timeseries id.
- `last_polled_at` (timestamptz): When the timeseries was last attempted.
- `updated_at` (timestamptz): Updated alongside `last_polled_at`.

## Usage
- `uk_aq_dispatch_polls` calls `uk_air_sos_select_timeseries_ids` to select the
  oldest checkpoints (nulls first) for each batch.
- `ingest_uk_air_sos` upserts rows after each batch run.
