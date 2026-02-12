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
    const record = value as {
      get?: () => Promise<string>;
      then?: (cb: (v: unknown) => void) => void;
    };
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

async function invokeFlush(env: Env): Promise<{
  ok: boolean;
  status: number;
  body: unknown;
}> {
  const supabaseUrl = await readSecret(env.SUPABASE_URL);
  const supabaseAnonJwt = await readSecret(env.SB_ANON_JWT);
  const cronSecret = await readSecret(env.SB_UK_AQ_CRON_SECRET ?? "");
  if (!supabaseUrl || !supabaseAnonJwt) {
    return {
      ok: false,
      status: 500,
      body: "missing_supabase_secrets",
    };
  }
  const url =
    `${normalizeBaseUrl(supabaseUrl)}/functions/v1/uk_aq_flush_history_outbox`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${supabaseAnonJwt}`,
    apikey: supabaseAnonJwt,
  };
  if (cronSecret) {
    headers["X-Cron-Secret"] = cronSecret;
  }

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ source: "cloudflare" }),
    });
    const contentType = (resp.headers.get("content-type") ?? "").toLowerCase();
    const body = contentType.includes("application/json")
      ? await resp.json().catch(() => null)
      : await resp.text().catch(() => "");
    return { ok: resp.ok, status: resp.status, body };
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : String(error ?? "unknown_error");
    return { ok: false, status: 0, body: message };
  }
}

async function runScheduled(env: Env): Promise<void> {
  const result = await invokeFlush(env);
  if (!result.ok) {
    console.error("uk_aq_flush_history_outbox failed", {
      status: result.status,
      body: result.body,
    });
    throw new Error("uk_aq_flush_history_outbox_failed");
  }
  console.log("uk_aq_flush_history_outbox succeeded", {
    status: result.status,
    body: result.body,
  });
}

export default {
  async scheduled(_event: unknown, env: Env, _ctx: unknown): Promise<void> {
    await runScheduled(env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    try {
      await runScheduled(env);
      return new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(
        JSON.stringify({ ok: false, error: message }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  },
};
