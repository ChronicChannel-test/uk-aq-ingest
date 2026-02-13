# TODO

- After deployment stabilizes, plan Option B: add `uk_aq_public` proxy RPCs so only `uk_aq_public` needs to be exposed.
- Review and improve UK-AIR SOS checkpointing and ingest flow: refine `uk_air_sos_timeseries_checkpoints` design and selection logic to better support predictable rotation, backfill, and long-running poll behavior.
- Look at lag/interval samples on OpenAQ gap mode. st_checkpoints isn't getting updated.
