FROM denoland/deno:2.1

ENV DENO_DIR=/deno-dir
ENV DENO_NET_ALLOW=dhkpqsjibdnizkulfujv.supabase.co,rpstqrzmpbbukejmcsdj.supabase.co

WORKDIR /app

COPY workers/uk_aq_history_outbox_cloud_run/run_job.ts /app/workers/uk_aq_history_outbox_cloud_run/run_job.ts
COPY supabase/functions/_shared/history_client.ts /app/supabase/functions/_shared/history_client.ts

RUN deno cache /app/workers/uk_aq_history_outbox_cloud_run/run_job.ts

CMD ["sh", "-c", "deno run --cached-only --allow-env --allow-net=$DENO_NET_ALLOW /app/workers/uk_aq_history_outbox_cloud_run/run_job.ts"]
