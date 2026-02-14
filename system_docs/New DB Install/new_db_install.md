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

Then configure Supabase Data API exposed schemas for the MAIN project:

1. Open Supabase Dashboard -> Settings -> Data API.
2. Ensure exposed schemas include: `public`, `uk_aq_core`, `uk_aq_raw`, `uk_aq_public`.
3. Save changes before running workflows/scripts that use PostgREST.

Notes:

1. Exposed schemas is a Supabase project setting (dashboard/API), not a SQL migration.
2. If `uk_aq_core`/`uk_aq_raw` are not exposed, PostgREST calls can fail with `406 PGRST106` errors.

Then set MAIN project runtime secrets:

1. `HISTORY_SUPABASE_URL`
2. `HISTORY_SERVICE_ROLE_KEY`
3. Optional: `HISTORY_UPSERT_RPC` (default `uk_aq_rpc_history_observations_upsert`)
4. Optional: `HISTORY_OUTBOX_FLUSH_LIMIT` (default `40`)
5. Optional: `HISTORY_UPSERT_CHUNK_SIZE` (default `5000`)
6. Optional: `HISTORY_OUTBOX_CLOUD_RUN_MAX_BATCHES` (default `30`)
7. Optional: `HISTORY_OUTBOX_CLOUD_RUN_CLAIM_BATCH_LIMIT` (default `20`)
8. Optional: `HISTORY_OUTBOX_CLOUD_RUN_BUDGET_SECONDS` (default `540`)

## 2. HISTORY DB install

Run SQL in this order.

1. `../CIC-Test-UK-AQ-Schema/uk-aq-schema/schemas/history_db/uk_aq_history_schema.sql`
2. `../CIC-Test-UK-AQ-Schema/uk-aq-schema/schemas/history_db/history_db_dualwrite_bootstrap.sql`

Notes:

1. History observations uses ID keys: `(connector_id, timeseries_id, observed_at)`.
2. History observations column is `created_at`.
3. History upsert RPC: `uk_aq_public.uk_aq_rpc_history_observations_upsert`.

## 3. Connector setup actions after install

Connector rows are created/updated by station list scripts. Run the relevant scripts to ensure connector rows exist before polling.

1. `scripts/openaq/openaq_list_stations.py`
2. `scripts/breathelondon/breathelondon_list_stations.py`
3. `scripts/erg_laqn/erg_laqn_list_stations.py`
4. `scripts/uk_air_sos/uk_air_sos_list_stations.py`
5. `scripts/sensorcommunity/sensorcommunity_list_stations.py`

During runtime, connector rows are also updated by dispatcher/ingest workers (`last_polled_at`, `last_run_start`, `last_run_end`, statuses).

## 4. Sensor.Community first-run order (fresh DB)

Run these in order before expecting Sensor.Community to appear on the hex map.

1. Confirm script schema profile is core (not public view):
   - `UK_AQ_CORE_SCHEMA=uk_aq_core`
2. Upsert Sensor.Community stations + connector row:
   - `python3 scripts/sensorcommunity/sensorcommunity_list_stations.py --to-supabase`
3. Assign PCON/LA codes to stations (required for map inclusion):
   - `python3 scripts/uk_aq_refresh_station_geo_aiven.py`
4. Run Sensor.Community ingest to populate timeseries/observations:
   - `python3 scripts/sensorcommunity/sensorcommunity_ingest.py --refresh-recent`
5. Backfill Sensor.Community timeseries phenomena:
   - `python3 scripts/sensorcommunity/sensorcommunity_backfill_timeseries_phenomena.py`
6. Run station geo refresh again to catch any newly inserted stations:
   - `python3 scripts/uk_aq_refresh_station_geo_aiven.py`

Notes:

1. `uk_aq_latest` excludes rows with no `pcon_code` and no `la_code`, so Sensor.Community can be missing from map filters until station geo refresh is done.
2. If you see `403 permission denied for view stations` when running geo refresh, `UK_AQ_CORE_SCHEMA` is set incorrectly (usually `uk_aq_public` instead of `uk_aq_core`).

## 5. UK-AQ webpage HTML update after DB switch

When moving to a new Supabase project ref/key, update the UK-AQ static HTML placeholders before deploy.

1. In `../CIC UK-AQ Webpage/CIC-test-uk-aq/.env`, set:
   - `SUPABASE_PROJECT_REF=<new-main-project-ref>`
   - `SB_ANON_JWT=<new-main-anon-key>`
2. Run injection script:
   - `cd "../CIC UK-AQ Webpage/CIC-test-uk-aq"`
   - `node scripts/uk_aq_inject_project_ref.mjs`
3. Deploy webpage (GH Pages / Cloudflare) after injection.

Notes:

1. GH Pages workflow (`.github/workflows/pages.yml`) runs injection in CI using repo secrets (`SUPABASE_PROJECT_REF`, `SB_ANON_JWT`), then deploys the built artifact.
2. GH Pages deploy does not write injected values back to git-tracked files in the repo; local files remain unchanged unless you run the script locally.
