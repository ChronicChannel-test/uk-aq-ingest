import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { cacheControlHeaders, CACHE_CONTROL_SUCCESS_SMAXAGE_300 } from "../_shared/cache.ts";
import { logEndpointEgress } from "../_shared/egress_metrics.ts";

const DEFAULT_WINDOW = "24h";

const WINDOW_HOURS: Record<string, number> = {
  "12h": 12,
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")
  ?? Deno.env.get("SB_SUPABASE_URL")
  ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  ?? Deno.env.get("SB_SERVICE_ROLE_KEY")
  ?? "";
const UK_AQ_CORE_SCHEMA = Deno.env.get("UK_AQ_CORE_SCHEMA")
  ?? "uk_aq_core";
const UK_AQ_PUBLIC_SCHEMA = Deno.env.get("UK_AQ_PUBLIC_SCHEMA")
  ?? "uk_aq_public";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const REST_BASE_URL = SUPABASE_URL
  ? `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1`
  : "";

function postgrestHeaders(schema = UK_AQ_CORE_SCHEMA): Record<string, string> {
  const headers: Record<string, string> = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  if (schema && schema !== "public") {
    headers["Accept-Profile"] = schema;
    headers["Content-Profile"] = schema;
  }
  return headers;
}

async function postgrestRequest<T>(
  method: string,
  path: string,
  params?: Record<string, string>,
  schema?: string,
  body?: unknown,
): Promise<{ data: T | null; error: { message: string } | null }> {
  if (!REST_BASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { data: null, error: { message: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." } };
  }
  const url = new URL(`${REST_BASE_URL}/${path}`);
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
  const payload: any = contentType.includes("application/json") ? await resp.json() : await resp.text();
  if (!resp.ok) {
    const message = payload?.message || payload?.error_description || payload?.error || resp.statusText;
    return { data: null, error: { message: String(message) } };
  }
  return { data: payload as T, error: null };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS_HEADERS,
        "Access-Control-Max-Age": "86400",
        ...cacheControlHeaders(204, CACHE_CONTROL_SUCCESS_SMAXAGE_300),
      },
    });
  }
  if (req.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...CORS_HEADERS, ...cacheControlHeaders(405, CACHE_CONTROL_SUCCESS_SMAXAGE_300) },
    });
  }
  const startedAtMs = Date.now();
  const finish = (response: Response, fields: Record<string, unknown> = {}) =>
    logEndpointEgress(req, "uk_aq_timeseries", startedAtMs, response, fields);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return await finish(json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." }, 500), {
      error_type: "missing_env",
    });
  }

  const url = new URL(req.url);
  const timeseriesId = parseId(url.searchParams.get("timeseries_id"));
  if (!timeseriesId) {
    return await finish(json({ error: "Missing or invalid timeseries_id." }, 400), {
      error_type: "invalid_timeseries_id",
    });
  }
  const windowLabel = normalizeWindow(url.searchParams.get("window"));
  const rawLimit = url.searchParams.get("limit");
  const limit = parseOptionalLimit(rawLimit);
  if (rawLimit !== null && limit === null) {
    return await finish(json({ error: "Invalid limit. Provide a positive integer or omit limit." }, 400), {
      error_type: "invalid_limit",
    });
  }
  const rawSince = url.searchParams.get("since");
  const since = rawSince === null ? null : normalizeTimestamp(rawSince);
  if (rawSince !== null && since === null) {
    return await finish(
      json({ error: "Invalid since timestamp. Provide ISO-8601 datetime (e.g. 2026-02-07T10:30:00Z)." }, 400),
      { error_type: "invalid_since" },
    );
  }
  const hours = WINDOW_HOURS[windowLabel] ?? WINDOW_HOURS[DEFAULT_WINDOW];
  const requestFields = {
    timeseries_id: timeseriesId,
    window: windowLabel,
    limit: limit ?? null,
    has_since: Boolean(since),
  };

  const end = new Date();
  const startTime = new Date(end.getTime() - hours * 60 * 60 * 1000);
  try {
    const { data, error } = await postgrestRequest<any[]>(
      "POST",
      "rpc/uk_aq_timeseries_rpc",
      undefined,
      UK_AQ_PUBLIC_SCHEMA,
      {
        timeseries_id: timeseriesId,
        window_label: windowLabel,
        limit_rows: limit,
        since_ts: since,
      },
    );
    if (error) {
      throw new Error(error.message);
    }
    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    const rows = Array.isArray(row?.data) ? row.data : [];
    const nextSince = maxObservedTimestamp(rows, since);
    return await finish(json({
      timeseries_id: row?.timeseries_id ?? timeseriesId,
      window: row?.window ?? windowLabel,
      start: row?.start ?? startTime.toISOString(),
      end: row?.end ?? end.toISOString(),
      since,
      next_since: nextSince,
      count: row?.count ?? rows.length,
      guideline: row?.guideline ?? null,
      data: rows,
    }), { ...requestFields, row_count: rows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await finish(json({ error: message }, 500), { ...requestFields, error_type: "runtime" });
  }
});

function parseId(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.floor(parsed);
}

function normalizeWindow(value: string | null): string {
  if (!value) {
    return DEFAULT_WINDOW;
  }
  const trimmed = value.trim();
  return WINDOW_HOURS[trimmed] ? trimmed : DEFAULT_WINDOW;
}

function parseOptionalLimit(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }
  return Math.floor(parsed);
}

function normalizeTimestamp(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function maxObservedTimestamp(rows: any[], fallback: string | null): string | null {
  let best = fallback ? normalizeTimestamp(fallback) : null;
  let bestMs = best ? Date.parse(best) : Number.NEGATIVE_INFINITY;
  rows.forEach((row) => {
    const observedAt = row?.observed_at;
    if (!observedAt) {
      return;
    }
    const normalized = normalizeTimestamp(String(observedAt));
    if (!normalized) {
      return;
    }
    const ms = Date.parse(normalized);
    if (ms > bestMs) {
      bestMs = ms;
      best = normalized;
    }
  });
  return best;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...cacheControlHeaders(status, CACHE_CONTROL_SUCCESS_SMAXAGE_300),
    },
  });
}
