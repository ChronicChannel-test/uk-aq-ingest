# uk_aq history outbox Cloud Run job

This Cloud Run job flushes `uk_aq_raw.history_observation_outbox` directly,
without going through Cloudflare Worker + Supabase edge-function chaining.

Design choices:
- moderate claims per batch (default `20`)
- bounded batch count per run (default `30`)
- bounded runtime budget (default `540s` with `20s` shutdown buffer)
- retry-aware main RPC calls to reduce transient network reset failures
- merges claimed outbox payloads per batch before history upsert to reduce
  history RPC call count and egress overhead
- retries history upsert RPC calls and can split large chunks on statement timeout

## Required env vars / secrets

- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `OBS_AQIDB_SUPABASE_URL`
- `OBS_AQIDB_SECRET_KEY`

## Optional env vars

- `UK_AQ_PUBLIC_SCHEMA` (default `uk_aq_public`)
- `OBS_AQIDB_RPC_SCHEMA` (default `uk_aq_public`)
- `HISTORY_UPSERT_RPC` (default `uk_aq_rpc_history_observations_upsert`)
- `HISTORY_OUTBOX_FLUSH_LIMIT` (default `40`)
- `HISTORY_UPSERT_CHUNK_SIZE` (default `5000`)
- `HISTORY_UPSERT_RPC_RETRIES` (default `3`; retries per history upsert RPC call for retryable failures)
- `HISTORY_UPSERT_RETRY_BASE_MS` (default `1000`; base backoff between history upsert retries)
- `HISTORY_UPSERT_TIMEOUT_SPLIT_MIN_ROWS` (default `32`; minimum chunk size that can be split when statement timeouts occur)
- `HISTORY_UPSERT_TIMEOUT_SPLIT_MAX_DEPTH` (default `4`; max recursive split depth for timeout fallback)
- `HISTORY_OUTBOX_CLOUD_RUN_MAX_BATCHES` (default `30`)
- `HISTORY_OUTBOX_CLOUD_RUN_CLAIM_BATCH_LIMIT` (default `20`)
- `HISTORY_OUTBOX_CLOUD_RUN_BUDGET_SECONDS` (default `540`)
- `HISTORY_OUTBOX_CLOUD_RUN_SHUTDOWN_BUFFER_SECONDS` (default `20`)
- `HISTORY_OUTBOX_CLOUD_RUN_RPC_RETRIES` (default `3`)
