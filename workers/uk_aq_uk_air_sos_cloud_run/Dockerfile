FROM denoland/deno:2.1.4

WORKDIR /app

COPY workers/uk_aq_uk_air_sos_cloud_run/run_job.ts /app/workers/uk_aq_uk_air_sos_cloud_run/run_job.ts

# Reuse existing SOS ingest implementation + shared helpers.
COPY supabase/functions/ingest_uk_air_sos/index.ts /app/runtime/ingest_uk_air_sos/index.ts
COPY supabase/functions/_shared/cache.ts /app/runtime/_shared/cache.ts
COPY supabase/functions/_shared/fetch_egress_patch.ts /app/runtime/_shared/fetch_egress_patch.ts
COPY supabase/functions/_shared/egress_metrics.ts /app/runtime/_shared/egress_metrics.ts
COPY supabase/functions/_shared/history_client.ts /app/runtime/_shared/history_client.ts
COPY supabase/functions/_shared/fetch_egress_patch.ts /app/supabase/functions/_shared/fetch_egress_patch.ts
COPY supabase/functions/_shared/egress_metrics.ts /app/supabase/functions/_shared/egress_metrics.ts

ENV PORT=8000

CMD ["deno", "run", "--allow-env", "--allow-net", "--allow-read", "--allow-write", "--allow-run", "/app/workers/uk_aq_uk_air_sos_cloud_run/run_job.ts"]
