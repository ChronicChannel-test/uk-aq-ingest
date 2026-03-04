# TODO

## Egress Reduction

- Route-shape follow-up (Option 3 after Option 2 baseline): split cache profiles into `/api/aq/meta/*` (long TTL) and `/api/aq/realtime/*` (short TTL). Use `realtime` naming (not `live`) to avoid confusion with test/live environments.

## Networks to add

- Add SaddleSense London cycling network.

## API Exposure

- After deployment stabilizes, plan Option B: add `uk_aq_public` proxy RPCs so only `uk_aq_public` needs to be exposed.

## Ingest Reliability and Checkpointing

- Review and improve UK-AIR SOS checkpointing and ingest flow: edge path still uses `uk_air_sos_timeseries_checkpoints`; if needed, migrate edge selection to the newer station-level model (`uk_air_sos_station_checkpoints`) now used by Cloud Run.
- Look at lag/interval samples on OpenAQ gap mode. `st_checkpoints` isn't getting updated.
- Phase B backup follow-up: keep existing single-day v1 backup as-is for now; add one-off migration task to rewrite that day to v2 backup schema later (drop `created_at`/`status` in migrated artifacts while preserving row-level granularity and manifest integrity).

## Data Model and Integrity

- Tidy up pollutants/phenomena. Mapping table from connector versions to phenomena.
- Investigate prune-repair edge case where `history_count > ingest_count` for a `(connector_id, hour_start)` bucket. Confirm if this can occur with current pipeline ordering/duplication behavior, and if needed add safe remediation path (history-side dedupe/remove or strict guardrail workflow).
