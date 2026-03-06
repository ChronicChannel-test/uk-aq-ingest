# uk_aq history Pub/Sub Cloud Run service

This Cloud Run service drains history observation messages from Pub/Sub, merges all
connectors into mixed batches, deduplicates by
`(connector_id, timeseries_id, observed_at)`, and upserts to history DB.

This supports the hourly mixed-row model so calls are chunked by total rows,
not by connector.

Scheduler triggers the service with an authenticated POST request.

## Required env vars / secrets

- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `HISTORY_SUPABASE_URL`
- `HISTORY_SECRET_KEY`
- `GCP_PROJECT_ID` (or `GOOGLE_CLOUD_PROJECT`)
- `HISTORY_PUBSUB_SUBSCRIPTION`

## Optional env vars

- `UK_AQ_PUBLIC_SCHEMA` (default `uk_aq_public`)
- `HISTORY_RPC_SCHEMA` (default `uk_aq_public`)
- `HISTORY_UPSERT_RPC` (default `uk_aq_rpc_history_observations_upsert`)
- `HISTORY_UPSERT_CHUNK_SIZE` (default `5000`)
- `HISTORY_UPSERT_RPC_RETRIES` (default `3`; retries per history upsert RPC call for retryable failures)
- `HISTORY_UPSERT_RETRY_BASE_MS` (default `1000`; base backoff between history upsert retries)
- `HISTORY_UPSERT_TIMEOUT_SPLIT_MIN_ROWS` (default `32`; minimum chunk size that can be split when statement timeouts occur)
- `HISTORY_UPSERT_TIMEOUT_SPLIT_MAX_DEPTH` (default `4`; max recursive split depth for timeout fallback)
- `HISTORY_PUBSUB_PULL_MAX_MESSAGES` (default `1000`)
- `HISTORY_PUBSUB_WRITER_MAX_BATCHES` (default `24`)
- `HISTORY_PUBSUB_WRITER_BUDGET_SECONDS` (default `1200`)
- `HISTORY_PUBSUB_WRITER_SHUTDOWN_BUFFER_SECONDS` (default `20`)
- `HISTORY_PUBSUB_WRITER_RPC_RETRIES` (default `3`)
- `HISTORY_PUBSUB_WRITER_PUBSUB_RETRIES` (default `3`)
