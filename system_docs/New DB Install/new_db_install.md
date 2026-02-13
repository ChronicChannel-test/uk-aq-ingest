# New DB Install

This guide is for bringing up fresh Supabase projects for:
- MAIN Ingest DB (UK AQ ingest + APIs)
- HISTORY DB (history observations store)

## 1. MAIN Ingest DB install

Run SQL in this order.

1. `../CIC-Test-UK-AQ-Schema/uk-aq-schema/schemas/main_db/uk_aq_core_schema.sql`
2. `../CIC-Test-UK-AQ-Schema/uk-aq-schema/schemas/main_db/uk_aq_raw_schema.sql`
3. `../CIC-Test-UK-AQ-Schema/uk-aq-schema/schemas/main_db/uk_aq_pop_schema.sql`
4. `../CIC-Test-UK-AQ-Schema/uk-aq-schema/schemas/main_db/uk_aq_rpc.sql`
5. `../CIC-Test-UK-AQ-Schema/uk-aq-schema/schemas/main_db/uk_aq_public_views.sql`
6. `../CIC-Test-UK-AQ-Schema/uk-aq-schema/schemas/main_db/uk_aq_security.sql`
7. `../CIC-Test-UK-AQ-Schema/uk-aq-schema/schemas/main_db/main_db_dualwrite_bootstrap.sql`
8. `supabase/uk_aq_polling_helpers.sql`

Then set MAIN project runtime secrets:

1. `HISTORY_SUPABASE_URL`
2. `HISTORY_SERVICE_ROLE_KEY`
3. Optional: `HISTORY_UPSERT_RPC` (default `uk_aq_rpc_history_observations_upsert`)
4. Optional: `HISTORY_OUTBOX_FLUSH_LIMIT` (default `20`)
5. Optional: `HISTORY_UPSERT_CHUNK_SIZE` (default `2000`)
6. Optional: `HISTORY_OUTBOX_CLOUD_RUN_MAX_BATCHES` (default `30`)
7. Optional: `HISTORY_OUTBOX_CLOUD_RUN_CLAIM_BATCH_LIMIT` (default `10`)
8. Optional: `HISTORY_OUTBOX_CLOUD_RUN_BUDGET_SECONDS` (default `540`)

## 2. HISTORY DB install

Run SQL in this order.

1. `../CIC-Test-UK-AQ-Schema/uk-aq-schema/schemas/history_db/uk_aq_history_schema.sql`
2. `../CIC-Test-UK-AQ-Schema/uk-aq-schema/schemas/history_db/history_db_dualwrite_bootstrap.sql`

Notes:

1. History observations column is `created_at` (not `moved_at`).
2. Bootstrap includes compatibility logic that renames legacy `moved_at` to `created_at` if needed.
3. History upsert RPC: `uk_aq_public.uk_aq_rpc_history_observations_upsert`.

## 3. Connector setup actions after install

Connector rows are created/updated by station list scripts. Run the relevant scripts to ensure connector rows exist before polling.

1. `scripts/openaq/openaq_list_stations.py`
2. `scripts/breathelondon/breathelondon_list_stations.py`
3. `scripts/erg_laqn/erg_laqn_list_stations.py`
4. `scripts/uk_air_sos/uk_air_sos_list_stations.py`
5. `scripts/sensorcommunity/sensorcommunity_list_stations.py`

During runtime, connector rows are also updated by dispatcher/ingest workers (`last_polled_at`, `last_run_start`, `last_run_end`, statuses).
