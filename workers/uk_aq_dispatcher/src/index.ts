export interface Env {
  SUPABASE_URL: unknown;
  SB_ANON_JWT: unknown;
  SB_UK_AQ_CRON_SECRET?: unknown;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}

async function readSecret(value: unknown): Promise<string> {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as { get?: () => Promise<string>; then?: (cb: (v: unknown) => void) => void };
    if (typeof record.get === "function") {
      const resolved = await record.get();
      return typeof resolved === "string" ? resolved : String(resolved ?? "");
    }
    if (typeof record.then === "function") {
      const resolved = await (value as Promise<unknown>);
      return typeof resolved === "string" ? resolved : String(resolved ?? "");
    }
  }
  return value ? String(value) : "";
}

async function invokeDispatch(
  env: Env,
  mode: "enqueue" | "run_queue" | "legacy",
): Promise<boolean> {
  const supabaseUrl = await readSecret(env.SUPABASE_URL);
  const supabaseAnonJwt = await readSecret(env.SB_ANON_JWT);
  const cronSecret = await readSecret(env.SB_UK_AQ_CRON_SECRET ?? "");
  if (!supabaseUrl || !supabaseAnonJwt) {
    console.error("Missing SUPABASE_URL or SB_ANON_JWT.");
    return false;
  }
  const url = `${normalizeBaseUrl(supabaseUrl)}/functions/v1/uk_aq_dispatch_polls`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${supabaseAnonJwt}`,
    apikey: supabaseAnonJwt,
  };
  if (cronSecret) {
    headers["X-Cron-Secret"] = cronSecret;
  }
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ source: "cloudflare", mode }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error("uk_aq_dispatch_polls failed", { mode, status: resp.status, body });
    return false;
  }
  const body = await resp.text().catch(() => "");
  console.log("uk_aq_dispatch_polls succeeded", { mode, body });
  return true;
}

export default {
  async scheduled(_event: unknown, env: Env, _ctx: unknown): Promise<void> {
    const enqueueOk = await invokeDispatch(env, "enqueue");
    if (!enqueueOk) {
      await invokeDispatch(env, "legacy");
      return;
    }
    const runQueueOk = await invokeDispatch(env, "run_queue");
    if (!runQueueOk) {
      await invokeDispatch(env, "legacy");
    }
  },
};
