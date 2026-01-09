// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const DEFAULT_LIMIT = 10000;
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
  const laVersion = normalizeText(url.searchParams.get("la_version"));
  const limit = parseLimit(url.searchParams.get("limit"), DEFAULT_LIMIT);

  try {
    const rows = await loadLatest({ laVersion, limit });
    const versions = Array.from(
      new Set(rows.map((row) => row.la_version).filter(Boolean)),
    ).sort();
    const lastUpdated = maxTimestamp(rows.map((row) => row.latest_value_at));
    return json({
      metric_default: "median",
      count: rows.length,
      la_versions: versions,
      last_updated: lastUpdated,
      data: rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, 500);
  }
});

type LoadOptions = {
  laVersion: string | null;
  limit: number;
};

type LaRow = {
  la_code: string;
  la_name: string | null;
  la_version: string | null;
  station_count: number | null;
  single_site: boolean | null;
  median_value: number | null;
  mean_value: number | null;
  latest_value_at: string | null;
};

async function loadLatest({ laVersion, limit }: LoadOptions): Promise<LaRow[]> {
  const params: Record<string, string> = {
    select: "la_code,la_name,la_version,station_count,single_site,median_value,mean_value,latest_value_at",
    limit: String(limit),
  };
  if (laVersion) {
    params.la_version = `eq.${laVersion}`;
  }
  const { data, error } = await postgrestRequest<LaRow[]>("GET", "la_latest_pm25", params);
  if (error) {
    throw new Error(error.message);
  }
  return data ?? [];
}

function normalizeText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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

function maxTimestamp(values: Array<string | null | undefined>): string | null {
  let maxValue: string | null = null;
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (!maxValue || value > maxValue) {
      maxValue = value;
    }
  }
  return maxValue;
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
