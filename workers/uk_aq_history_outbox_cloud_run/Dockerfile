FROM denoland/deno:2.1.4

ENV DENO_DIR=/deno-dir
ENV DENO_NET_ALLOW=

WORKDIR /app

COPY workers/uk_aq_history_outbox_cloud_run/run_job.ts /app/workers/uk_aq_history_outbox_cloud_run/run_job.ts
COPY supabase/functions/_shared/fetch_egress_patch.ts /app/supabase/functions/_shared/fetch_egress_patch.ts
COPY supabase/functions/_shared/egress_metrics.ts /app/supabase/functions/_shared/egress_metrics.ts
COPY supabase/functions/_shared/history_client.ts /app/supabase/functions/_shared/history_client.ts

RUN deno cache /app/workers/uk_aq_history_outbox_cloud_run/run_job.ts

CMD ["sh", "-c", "set -eu; NET_ALLOW=\"${DENO_NET_ALLOW:-}\"; if [ -z \"$NET_ALLOW\" ]; then MAIN_HOST=\"${SUPABASE_URL#*://}\"; MAIN_HOST=\"${MAIN_HOST%%/*}\"; HISTORY_HOST=\"${OBS_AQIDB_SUPABASE_URL#*://}\"; HISTORY_HOST=\"${HISTORY_HOST%%/*}\"; if [ -z \"$MAIN_HOST\" ] || [ -z \"$HISTORY_HOST\" ]; then echo \"Missing host allowlist values (SUPABASE_URL/OBS_AQIDB_SUPABASE_URL).\" >&2; exit 1; fi; NET_ALLOW=\"${MAIN_HOST},${HISTORY_HOST}\"; fi; deno run --cached-only --allow-env --allow-net=\"$NET_ALLOW\" /app/workers/uk_aq_history_outbox_cloud_run/run_job.ts"]
