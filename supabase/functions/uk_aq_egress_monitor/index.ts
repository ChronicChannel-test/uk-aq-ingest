import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import "../_shared/fetch_egress_patch.ts";

type EgressMinuteRow = {
  endpoint: string | null;
  response_bytes_sum: number | null;
  observed_requests: number | null;
  bucket_minute: string | null;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ??
  Deno.env.get("SB_SUPABASE_URL") ??
  "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SB_SERVICE_ROLE_KEY") ??
  "";
const SB_UK_AQ_CRON_SECRET = Deno.env.get("SB_UK_AQ_CRON_SECRET") ?? "";
const UK_AQ_PUBLIC_SCHEMA = Deno.env.get("UK_AQ_PUBLIC_SCHEMA") ?? "uk_aq_public";
const UK_AQ_RAW_SCHEMA = Deno.env.get("UK_AQ_RAW_SCHEMA") ?? "uk_aq_raw";
const REST_BASE_URL = SUPABASE_URL
  ? `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1`
  : "";

const DEFAULT_LOOKBACK_MINUTES = 60;
const DEFAULT_TOP_N = 20;
const DEFAULT_ALERT_MB = 250;
const DEFAULT_WRITE_ERROR_LOG = true;
const EGRESS_BYPASS_HEADER = "x-ukaq-egress-bypass";

function parsePositiveInt(
  raw: string | undefined | null,
  fallback: number,
  min = 1,
  max = 100_000,
): number {
  const parsed = Number(raw ?? "");
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function parseBoolean(
  raw: string | undefined | null,
  fallback: boolean,
): boolean {
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parsePositiveNumber(
  raw: string | undefined | null,
  fallback: number,
): number {
  const parsed = Number(raw ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function requireCronSecret(req: Request): Response | null {
  if (!SB_UK_AQ_CRON_SECRET) {
    return null;
  }
  const header = req.headers.get("x-cron-secret");
  if (!header || header !== SB_UK_AQ_CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

function postgrestHeaders(schema = UK_AQ_PUBLIC_SCHEMA): Record<string, string> {
  const headers: Record<string, string> = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    [EGRESS_BYPASS_HEADER]: "1",
  };
  if (schema && schema !== "public") {
    headers["Accept-Profile"] = schema;
    headers["Content-Profile"] = schema;
  }
  return headers;
}

async function postgrestRequest<T>(
  method: string,
  table: string,
  params?: Record<string, string>,
  body?: unknown,
  schema = UK_AQ_PUBLIC_SCHEMA,
): Promise<{ data: T | null; error: { message: string } | null }> {
  if (!REST_BASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return {
      data: null,
      error: { message: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." },
    };
  }
  const url = new URL(`${REST_BASE_URL}/${table}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const resp = await fetch(url.toString(), {
    method,
    headers: postgrestHeaders(schema),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = resp.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await resp.json().catch(() => null)
    : await resp.text().catch(() => null);
  if (!resp.ok) {
    const message = payload?.message || payload?.error_description ||
      payload?.error || resp.statusText;
    return { data: null, error: { message: String(message || "PostgREST request failed.") } };
  }
  return { data: payload as T, error: null };
}

function toMiB(bytes: number): number {
  return bytes / (1024 * 1024);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const authResponse = requireCronSecret(req);
  if (authResponse) {
    return authResponse;
  }
  try {
    const url = new URL(req.url);
    const lookbackMinutes = parsePositiveInt(
      url.searchParams.get("lookback_minutes") ??
        Deno.env.get("UK_AQ_EGRESS_MONITOR_LOOKBACK_MINUTES"),
      DEFAULT_LOOKBACK_MINUTES,
      1,
      1440,
    );
    const topN = parsePositiveInt(
      url.searchParams.get("top_n") ?? Deno.env.get("UK_AQ_EGRESS_MONITOR_TOP_N"),
      DEFAULT_TOP_N,
      1,
      100,
    );
    const alertMb = parsePositiveNumber(
      url.searchParams.get("alert_mb") ??
        Deno.env.get("UK_AQ_EGRESS_MONITOR_ALERT_MB"),
      DEFAULT_ALERT_MB,
    );
    const writeErrorLog = parseBoolean(
      url.searchParams.get("write_error_log") ??
        Deno.env.get("UK_AQ_EGRESS_MONITOR_WRITE_ERROR_LOG"),
      DEFAULT_WRITE_ERROR_LOG,
    );

    const sinceIso = new Date(Date.now() - (lookbackMinutes * 60 * 1000))
      .toISOString();
    const { data, error } = await postgrestRequest<EgressMinuteRow[]>(
      "GET",
      "uk_aq_endpoint_egress_metrics_minute",
      {
        select: "endpoint,response_bytes_sum,observed_requests,bucket_minute",
        bucket_minute: `gte.${sinceIso}`,
        limit: "10000",
      },
      undefined,
      UK_AQ_PUBLIC_SCHEMA,
    );
    if (error) {
      throw new Error(`Failed to load egress metrics: ${error.message}`);
    }

    const totals = new Map<string, { bytes: number; requests: number }>();
    let totalBytes = 0;
    let totalRequests = 0;
    for (const row of data ?? []) {
      const endpoint = String(row.endpoint ?? "").trim() || "unknown";
      const bytes = Math.max(0, Number(row.response_bytes_sum ?? 0));
      const requests = Math.max(0, Number(row.observed_requests ?? 0));
      totalBytes += bytes;
      totalRequests += requests;
      const existing = totals.get(endpoint) ?? { bytes: 0, requests: 0 };
      existing.bytes += bytes;
      existing.requests += requests;
      totals.set(endpoint, existing);
    }

    const topEndpoints = Array.from(totals.entries())
      .map(([endpoint, value]) => ({
        endpoint,
        mb: Number(toMiB(value.bytes).toFixed(3)),
        requests: value.requests,
      }))
      .sort((a, b) => b.mb - a.mb)
      .slice(0, topN);

    const totalMb = Number(toMiB(totalBytes).toFixed(3));
    const thresholdExceeded = totalMb >= alertMb;

    if (thresholdExceeded) {
      console.warn("uk_aq_egress_monitor_threshold_exceeded", {
        total_mb: totalMb,
        alert_mb: alertMb,
        lookback_minutes: lookbackMinutes,
        top_endpoint: topEndpoints[0]?.endpoint ?? null,
      });
      if (writeErrorLog) {
        const { error: logError } = await postgrestRequest(
          "POST",
          "error_logs",
          undefined,
          {
            source: "edge",
            severity: "warn",
            message: "uk_aq_egress_monitor threshold exceeded",
            stack: null,
            context: {
              total_mb: totalMb,
              alert_mb: alertMb,
              lookback_minutes: lookbackMinutes,
              top_endpoints: topEndpoints.slice(0, 5),
            },
            connector_id: null,
            station_id: null,
            timeseries_id: null,
          },
          UK_AQ_RAW_SCHEMA,
        );
        if (logError) {
          console.warn("uk_aq_egress_monitor_error_log_failed", {
            error: logError.message,
          });
        }
      }
    }

    return new Response(
      JSON.stringify({
        checked_at: new Date().toISOString(),
        lookback_minutes: lookbackMinutes,
        rows_scanned: data?.length ?? 0,
        total_mb: totalMb,
        total_requests: totalRequests,
        alert_threshold_mb: alertMb,
        threshold_exceeded: thresholdExceeded,
        top_endpoints: topEndpoints,
      }, null, 2),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }, null, 2), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
