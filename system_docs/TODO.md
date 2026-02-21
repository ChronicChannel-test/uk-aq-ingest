# TODO

- After deployment stabilizes, plan Option B: add `uk_aq_public` proxy RPCs so only `uk_aq_public` needs to be exposed.
- Review and improve UK-AIR SOS checkpointing and ingest flow: edge path still uses `uk_air_sos_timeseries_checkpoints`; if needed, migrate edge selection to the newer station-level model (`uk_air_sos_station_checkpoints`) now used by Cloud Run.
- Look at lag/interval samples on OpenAQ gap mode. st_checkpoints isn't getting updated.
- Tidy up pollutants/phenomena. Mapping table from connectors version to phenomena.
- Investigate prune-repair edge case where `history_count > ingest_count` for a `(connector_id, hour_start)` bucket. Confirm if this can occur with current pipeline ordering/duplication behavior, and if needed add safe remediation path (history-side dedupe/remove or strict guardrail workflow).
