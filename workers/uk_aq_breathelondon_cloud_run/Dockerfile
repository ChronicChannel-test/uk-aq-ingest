FROM denoland/deno:2.1.4

WORKDIR /app

# Cloud Run Job runner
COPY workers/uk_aq_breathelondon_cloud_run/run_job.ts /app/run_job.ts

# Reuse existing BL ingest implementation + shared helpers.
COPY supabase/functions/ingest_breathelondon/index.ts /app/runtime/ingest_breathelondon/index.ts
COPY supabase/functions/_shared/cache.ts /app/runtime/_shared/cache.ts
COPY supabase/functions/_shared/fetch_egress_patch.ts /app/runtime/_shared/fetch_egress_patch.ts
COPY supabase/functions/_shared/egress_metrics.ts /app/runtime/_shared/egress_metrics.ts
COPY supabase/functions/_shared/history_client.ts /app/runtime/_shared/history_client.ts

ENV PORT=8000

CMD ["deno", "run", "--allow-env", "--allow-net", "--allow-read", "--allow-write", "--allow-run", "/app/run_job.ts"]
