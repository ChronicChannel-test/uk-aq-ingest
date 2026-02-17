# uk_aq history Pub/Sub Cloud Run job

This Cloud Run job drains history observation messages from Pub/Sub, merges all
connectors into mixed batches, deduplicates by
`(connector_id, timeseries_id, observed_at)`, and upserts to history DB.

This supports the hourly mixed-row model so calls are chunked by total rows,
not by connector.

## Required env vars / secrets

- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `HISTORY_SUPABASE_URL`
- `HISTORY_SERVICE_ROLE_KEY`
- `GCP_PROJECT_ID` (or `GOOGLE_CLOUD_PROJECT`)
- `HISTORY_PUBSUB_SUBSCRIPTION`

## Optional env vars

- `UK_AQ_PUBLIC_SCHEMA` (default `uk_aq_public`)
- `HISTORY_SCHEMA` (default `uk_aq_public`)
- `HISTORY_UPSERT_RPC` (default `uk_aq_rpc_history_observations_upsert`)
- `HISTORY_UPSERT_CHUNK_SIZE` (default `5000`)
- `HISTORY_PUBSUB_PULL_MAX_MESSAGES` (default `1000`)
- `HISTORY_PUBSUB_WRITER_MAX_BATCHES` (default `24`)
- `HISTORY_PUBSUB_WRITER_BUDGET_SECONDS` (default `1200`)
- `HISTORY_PUBSUB_WRITER_SHUTDOWN_BUFFER_SECONDS` (default `20`)
- `HISTORY_PUBSUB_WRITER_RPC_RETRIES` (default `3`)
- `HISTORY_PUBSUB_WRITER_PUBSUB_RETRIES` (default `3`)
