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

## Required env vars / secrets

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `HISTORY_SUPABASE_URL`
- `HISTORY_SERVICE_ROLE_KEY`

## Optional env vars

- `UK_AQ_PUBLIC_SCHEMA` (default `uk_aq_public`)
- `HISTORY_SCHEMA` (default `uk_aq_public`)
- `HISTORY_UPSERT_RPC` (default `uk_aq_rpc_history_observations_upsert`)
- `HISTORY_OUTBOX_FLUSH_LIMIT` (default `40`)
- `HISTORY_UPSERT_CHUNK_SIZE` (default `5000`)
- `HISTORY_OUTBOX_CLOUD_RUN_MAX_BATCHES` (default `30`)
- `HISTORY_OUTBOX_CLOUD_RUN_CLAIM_BATCH_LIMIT` (default `20`)
- `HISTORY_OUTBOX_CLOUD_RUN_BUDGET_SECONDS` (default `540`)
- `HISTORY_OUTBOX_CLOUD_RUN_SHUTDOWN_BUFFER_SECONDS` (default `20`)
- `HISTORY_OUTBOX_CLOUD_RUN_RPC_RETRIES` (default `3`)
