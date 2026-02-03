// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { cacheControlHeaders, CACHE_CONTROL_SUCCESS_SMAXAGE_300 } from "../_shared/cache.ts";

const DEFAULT_WINDOW = "24h";
const DEFAULT_LIMIT = 20000;
const MAX_LIMIT = 60000;

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
  const payload = contentType.includes("application/json") ? await resp.json() : await resp.text();
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
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." }, 500);
  }

  const url = new URL(req.url);
  const timeseriesId = parseId(url.searchParams.get("timeseries_id"));
  if (!timeseriesId) {
    return json({ error: "Missing or invalid timeseries_id." }, 400);
  }
  const windowLabel = normalizeWindow(url.searchParams.get("window"));
  const limit = parseLimit(url.searchParams.get("limit"), DEFAULT_LIMIT);
  const hours = WINDOW_HOURS[windowLabel] ?? WINDOW_HOURS[DEFAULT_WINDOW];

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
      },
    );
    if (error) {
      throw new Error(error.message);
    }
    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    const rows = Array.isArray(row?.data) ? row.data : [];
    return json({
      timeseries_id: row?.timeseries_id ?? timeseriesId,
      window: row?.window ?? windowLabel,
      start: row?.start ?? startTime.toISOString(),
      end: row?.end ?? end.toISOString(),
      count: row?.count ?? rows.length,
      guideline: row?.guideline ?? null,
      data: rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, 500);
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

function parseLimit(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(parsed)));
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
