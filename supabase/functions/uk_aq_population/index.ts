// @ts-nocheck
// Deployment touchpoint: change triggers edge deploy workflow. MJH
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 20000;
const POPULATION_VIEW = "uk_population_observations";

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
  const geoType = normalizeText(url.searchParams.get("geo_type"));
  const referenceDateParam = url.searchParams.get("reference_date");
  const referenceDate = normalizeDate(referenceDateParam);
  const limit = parseLimit(url.searchParams.get("limit"), DEFAULT_LIMIT);

  if (!geoType) {
    return json({ error: "Missing geo_type." }, 400);
  }
  if (referenceDateParam && !referenceDate) {
    return json({ error: "Invalid reference_date. Use YYYY-MM-DD." }, 400);
  }

  try {
    const resolvedDate = referenceDate || await fetchLatestDate(geoType);
    if (!resolvedDate) {
      return json({ geo_type: geoType, reference_date: null, count: 0, data: [] });
    }
    const { data, error } = await postgrestRequest<any[]>("GET", POPULATION_VIEW, {
      select: "geo_code,geo_type,reference_date,population_value,dataset_id,measure",
      geo_type: `eq.${geoType}`,
      reference_date: `eq.${resolvedDate}`,
      order: "geo_code.asc",
      limit: String(limit),
    });
    if (error) {
      throw new Error(error.message);
    }
    return json({
      geo_type: geoType,
      reference_date: resolvedDate,
      count: data?.length ?? 0,
      data: data ?? [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, 500);
  }
});

async function fetchLatestDate(geoType: string): Promise<string | null> {
  const { data, error } = await postgrestRequest<any[]>("GET", POPULATION_VIEW, {
    select: "reference_date",
    geo_type: `eq.${geoType}`,
    order: "reference_date.desc",
    limit: "1",
  });
  if (error) {
    throw new Error(error.message);
  }
  return data?.[0]?.reference_date ?? null;
}

function normalizeText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeDate(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
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
    },
  });
}
