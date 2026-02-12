# UK AQ Egress Execution Checklist

Last updated: 2026-02-12

Use this file as the working checklist. Keep `plans/egress_reduction_plan.md` as the higher-level strategy reference.

## Completed

- [x] Endpoint egress metrics model added (`supabase/uk_aq_egress_metrics.sql`).
- [x] `uk_aq_latest` supports incremental fetch (`since`/`since_id`) and conditional fetch (`ETag`/`If-None-Match`).
- [x] `uk_aq_latest` payload trimmed for map usage.
- [x] Map latest-row merge key moved to `station_id + pollutant`.
- [x] `uk_aq_pcon_hex` supports `ETag`/`If-None-Match`.
- [x] `uk_aq_la_hex` supports `ETag`/`If-None-Match`.
- [x] Hex map client now sends `If-None-Match` for `uk_aq_pcon_hex` and `uk_aq_la_hex`.

## Next (in order)

- [ ] Deploy updated edge functions: `uk_aq_pcon_hex`, `uk_aq_la_hex`, `uk_aq_latest`.
- [ ] Deploy updated webpage: `uk_aq_hex_map.html`.
- [ ] Compare 24h endpoint egress before vs after deployment (`uk_aq_latest`, `uk_aq_pcon_hex`, `uk_aq_la_hex`).
- [ ] If needed, add `ETag`/`If-None-Match` to `uk_aq_timeseries`.
- [ ] If needed, increase map polling interval from 60s to 120s.

## Validation Queries

```sql
-- Endpoint egress totals (MB) for a lookback window
select
  endpoint,
  round(sum(response_bytes_sum)::numeric / 1024 / 1024, 2) as mb,
  sum(observed_requests) as requests
from uk_aq_public.uk_aq_endpoint_egress_metrics_minute
where bucket_minute >= now() - interval '24 hours'
  and endpoint in ('uk_aq_latest', 'uk_aq_pcon_hex', 'uk_aq_la_hex')
group by endpoint
order by mb desc;
```
