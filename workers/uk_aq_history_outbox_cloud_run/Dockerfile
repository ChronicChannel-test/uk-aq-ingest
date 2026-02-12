FROM denoland/deno:2.1.4

ENV DENO_DIR=/deno-dir

WORKDIR /app

COPY workers/uk_aq_history_outbox_cloud_run/run_job.ts /app/workers/uk_aq_history_outbox_cloud_run/run_job.ts
COPY supabase/functions/_shared/history_client.ts /app/supabase/functions/_shared/history_client.ts

RUN deno cache /app/workers/uk_aq_history_outbox_cloud_run/run_job.ts

CMD ["deno", "run", "--cached-only", "--allow-env", "--allow-net", "/app/workers/uk_aq_history_outbox_cloud_run/run_job.ts"]
