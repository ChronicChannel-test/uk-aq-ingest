# UK AQ Egress Execution Checklist

Last updated: 2026-02-13

Use this file as the working checklist. Keep `plans/egress_reduction_plan.md` as the higher-level strategy reference.

## Completed

- [x] Endpoint egress metrics model added (`supabase/uk_aq_egress_metrics.sql`).
- [x] `uk_aq_latest` supports incremental fetch (`since`/`since_id`) and conditional fetch (`ETag`/`If-None-Match`).
- [x] `uk_aq_latest` payload trimmed for map usage.
- [x] Map latest-row merge key moved to `station_id + pollutant`.
- [x] `uk_aq_pcon_hex` supports `ETag`/`If-None-Match`.
- [x] `uk_aq_la_hex` supports `ETag`/`If-None-Match`.
- [x] `uk_aq_pcon_hex` + `uk_aq_la_hex` support optional incremental `since` cursor and return `next_since`.
- [x] `uk_aq_timeseries` supports `ETag`/`If-None-Match` (including `since` delta no-change fast path).
- [x] `uk_aq_timeseries` supports compact wire format (`format=compact`) and optional `include_status=false` for chart reads.
- [x] `uk_aq_timeseries` removed extra `since` delta preflight RPC call (single RPC path per request, with ETag-based 304 handling).
- [x] Hex map client now sends `If-None-Match` for `uk_aq_pcon_hex` and `uk_aq_la_hex`.
- [x] Station trend clients now send `If-None-Match` for `uk_aq_timeseries` (`index`, `uk_aq_bristol`, `uk_aq_surbiton`).
- [x] Station trend clients now request compact series payloads with `include_status=false` and persist chart cache (`since`/`ETag`/points/guideline) in `localStorage`.
- [x] History outbox throughput defaults tuned in code:
  - `HISTORY_OUTBOX_CLOUD_RUN_CLAIM_BATCH_LIMIT=20`
  - `HISTORY_OUTBOX_FLUSH_LIMIT=40`
  - `HISTORY_UPSERT_CHUNK_SIZE=5000`
- [x] History dual-write payload path now normalizes + dedupes rows by `(connector_id, timeseries_id, observed_at)` before history upsert/outbox enqueue (Edge shared helper + SensorCommunity Cloud Run worker).

## Next (in order)

- [ ] Final batch deploy (one release hit before restart): edge functions + webpage assets.
  - `uk_aq_pcon_hex`, `uk_aq_la_hex`, `uk_aq_latest`, `uk_aq_timeseries`
  - `uk_aq_hex_map.html`, `index.html`, `uk_aq_stations_chart.html`
- [ ] Compare 24h endpoint egress before vs after deployment (`uk_aq_latest`, `uk_aq_pcon_hex`, `uk_aq_la_hex`, `uk_aq_timeseries`).
- [ ] Measure history project API request baseline (`usage.api-requests-count`, `usage.api-counts`) and record daily deltas.
- [x] Refactor high-churn ingestors to batch history writes per run (reduce `writeHistoryWithOutbox` calls inside tight loops).
- [ ] Verify queue drain + runtime budget with current outbox defaults (`HISTORY_OUTBOX_CLOUD_RUN_CLAIM_BATCH_LIMIT=20`, `HISTORY_OUTBOX_FLUSH_LIMIT=40`, `HISTORY_UPSERT_CHUNK_SIZE=5000`).
- [x] Validate history index footprint and remove duplicate PK-like btree index if present.

## Validation Queries

```sql
-- Endpoint egress totals (MB) for a lookback window
select
  endpoint,
  round(sum(response_bytes_sum)::numeric / 1024 / 1024, 2) as mb,
  sum(observed_requests) as requests
from uk_aq_public.uk_aq_endpoint_egress_metrics_minute
where bucket_minute >= now() - interval '24 hours'
  and endpoint in ('uk_aq_latest', 'uk_aq_pcon_hex', 'uk_aq_la_hex', 'uk_aq_timeseries')
group by endpoint
order by mb desc;
```

```bash
# Management API request-count snapshots (history vs main)
curl -sS -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/$HISTORY_SUPABASE_PROJECT_REF/analytics/endpoints/usage.api-requests-count"

curl -sS -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/analytics/endpoints/usage.api-requests-count"
```
