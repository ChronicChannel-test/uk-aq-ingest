export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_JWT: string;
  SB_UK_AQ_CRON_SECRET?: string;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}

async function invokeDispatch(env: Env): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_JWT) {
    console.error("Missing SUPABASE_URL or SUPABASE_ANON_JWT.");
    return;
  }
  const url = `${normalizeBaseUrl(env.SUPABASE_URL)}/functions/v1/uk_aq_dispatch_polls`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.SUPABASE_ANON_JWT}`,
    apikey: env.SUPABASE_ANON_JWT,
  };
  if (env.SB_UK_AQ_CRON_SECRET) {
    headers["X-Cron-Secret"] = env.SB_UK_AQ_CRON_SECRET;
  }
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ source: "cloudflare" }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error("uk_aq_dispatch_polls failed", resp.status, body);
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await invokeDispatch(env);
  },
};
