# TODO

- After deployment stabilizes, plan Option B: add `uk_aq_public` proxy RPCs so only `uk_aq_public` needs to be exposed.
- Review and improve UK-AIR SOS checkpointing and ingest flow: edge path still uses `uk_air_sos_timeseries_checkpoints`; if needed, migrate edge selection to the newer station-level model (`uk_air_sos_station_checkpoints`) now used by Cloud Run.
- Look at lag/interval samples on OpenAQ gap mode. st_checkpoints isn't getting updated.
- Tidy up pollutants/phenomena. Mapping table from connectors version to phenomena.