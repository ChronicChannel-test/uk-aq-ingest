// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 5000;
const MAX_LIMIT = 20000;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")
  ?? Deno.env.get("SB_SUPABASE_URL")
  ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  ?? Deno.env.get("SB_SERVICE_ROLE_KEY")
  ?? "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const REST_BASE_URL = SUPABASE_URL
  ? `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1`
  : "";

function postgrestHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function postgrestRequest<T>(
  method: string,
  table: string,
  params?: Record<string, string>,
): Promise<{ data: T | null; error: { message: string } | null }> {
  if (!REST_BASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { data: null, error: { message: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." } };
  }
  const url = new URL(`${REST_BASE_URL}/${table}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const resp = await fetch(url.toString(), {
    method,
    headers: postgrestHeaders(),
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
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." }, 500);
  }

  const url = new URL(req.url);
  const serviceId = normalizeText(url.searchParams.get("service_id"));
  const region = normalizeText(url.searchParams.get("region"));
  const stationLike = normalizeText(url.searchParams.get("station_like"));
  const targetLimit = parseLimit(url.searchParams.get("limit"), MAX_LIMIT);
  const pageSize = parseLimit(url.searchParams.get("page_size"), MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);

  try {
    const rows = await fetchStations({
      serviceId,
      region,
      stationLike,
      targetLimit,
      pageSize,
    });
    return json(rows);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, 500);
  }
});

type FetchOptions = {
  serviceId: string | null;
  region: string | null;
  stationLike: string | null;
  targetLimit: number | null;
  pageSize: number;
};

async function fetchStations({
  serviceId,
  region,
  stationLike,
  targetLimit,
  pageSize,
}: FetchOptions) {
  const rows: Array<Record<string, unknown>> = [];
  let offset = 0;
  const baseParams: Record<string, string> = {
    select: "id,station_ref,label,geometry",
    geometry: "not.is.null",
  };
  if (serviceId) {
    baseParams.service_id = `eq.${serviceId}`;
  }
  if (region) {
    baseParams.region = `ilike.*${region}*`;
  }
  if (stationLike) {
    baseParams.label = `ilike.*${stationLike}*`;
  }

  while (true) {
    const remaining = targetLimit ? Math.max(0, targetLimit - rows.length) : pageSize;
    if (targetLimit && remaining === 0) {
      break;
    }
    const limit = Math.min(pageSize, remaining || pageSize);
    const { data, error } = await postgrestRequest<Array<Record<string, unknown>>>("GET", "stations", {
      ...baseParams,
      limit: String(limit),
      offset: String(offset),
    });
    if (error) {
      throw new Error(error.message);
    }
    const page = data ?? [];
    rows.push(...page);
    if (page.length < limit) {
      break;
    }
    offset += page.length;
  }

  return rows;
}

function normalizeText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseLimit(value: string | null, max: number, fallback: number | null = null): number | null {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const clamped = Math.min(max, Math.max(1, Math.floor(parsed)));
  return clamped;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}
