# uk_aq_ops.service_egress_metrics_minute

Minute-level rollup ledger for service-attributed egress/transfer metrics.

## Purpose

- Attribute traffic by service/job/route/window with low write volume.
- Keep source types explicit (`supabase`, `r2`, `cloudflare_cache`, `gcp`, `other`).
- Support side-by-side tracking when a service moves from Supabase to another source.

## Grain

One row per minute per dimension tuple:

- `bucket_minute`
- `env_name`
- `project_ref`
- `service_name`
- `source_type`
- `source_name`
- `route_name`
- `query_name`
- `window_label`
- `status`

## Key columns

- Volume counters:
  - `request_count`
  - `response_rows`
  - `response_bytes_est`
  - `upstream_bytes_est`
  - `objects_written_count`
  - `objects_written_bytes`
  - `duration_ms`
  - `error_count`
- Cache counters:
  - `cache_hit_count`
  - `cache_miss_count`
- Metadata:
  - `notes` (`jsonb`)
  - `recorded_at`, `created_at`, `updated_at`

## Write path

- RPC: `uk_aq_public.uk_aq_rpc_service_egress_metrics_batch_upsert(jsonb)`
- Auth: `service_role` only
- Behavior: UPSERT + additive counter merge on conflict

## Read paths

- `uk_aq_public.uk_aq_service_egress_metrics_minute`
- `uk_aq_public.uk_aq_service_egress_metrics_daily`

## Notes

- This is an estimated attribution layer, not the Supabase billing authority.
- Upload/write payload bytes and response/download bytes must be interpreted separately.
