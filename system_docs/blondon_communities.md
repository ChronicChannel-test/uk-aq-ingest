# Breathe London Communities ingest

Breathe London Communities uses connector code `blondon_communities` and raw
PM2.5/NO2 timeseries.

Phenomena are written through
`uk_aq_public.uk_aq_rpc_phenomena_upsert`. Connector/source mappings are
authoritative in `uk_aq_core.observed_property_mappings`; unknown source labels
fail closed instead of being silently inferred. The connector does not create
source-provided DAQI index timeseries.
