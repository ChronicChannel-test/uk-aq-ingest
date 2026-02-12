FROM denoland/deno:2.1.4

WORKDIR /app/workers/uk_aq_history_outbox_cloud_run

COPY workers/uk_aq_history_outbox_cloud_run/run_job.ts /app/workers/uk_aq_history_outbox_cloud_run/run_job.ts
COPY supabase/functions/_shared/history_client.ts /app/supabase/functions/_shared/history_client.ts

CMD ["deno", "run", "--allow-env", "--allow-net", "/app/workers/uk_aq_history_outbox_cloud_run/run_job.ts"]
