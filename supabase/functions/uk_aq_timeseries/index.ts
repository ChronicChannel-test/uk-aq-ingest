// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const DEFAULT_WINDOW = "24h";
const DEFAULT_LIMIT = 20000;
const MAX_LIMIT = 60000;
const GUIDELINE_PERIOD = "24h";

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
  const timeseriesId = parseId(url.searchParams.get("timeseries_id"));
  if (!timeseriesId) {
    return json({ error: "Missing or invalid timeseries_id." }, 400);
  }
  const windowLabel = normalizeWindow(url.searchParams.get("window"));
  const limit = parseLimit(url.searchParams.get("limit"), DEFAULT_LIMIT);
  const hours = WINDOW_HOURS[windowLabel] ?? WINDOW_HOURS[DEFAULT_WINDOW];

  const end = new Date();
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  let guideline: Record<string, unknown> | null = null;

  try {
    const pollutantKey = await getPollutantKey(timeseriesId);
    if (pollutantKey) {
      const { data: guidelineRows, error: guidelineError } = await postgrestRequest<any[]>(
        "GET",
        "uk_aq_guidelines",
        {
          select: "pollutant,averaging_period_label,level_label,limit_value,uom,source,notes",
          pollutant: `eq.${pollutantKey}`,
          averaging_period_label: `eq.${GUIDELINE_PERIOD}`,
          level_label: "eq.AQG_2021",
          limit: "1",
        },
      );
      if (!guidelineError && guidelineRows && guidelineRows.length > 0) {
        guideline = guidelineRows[0];
      }
    }

    const { data, error } = await postgrestRequest<any[]>("GET", "observations", {
      select: "observed_at,value,status",
      timeseries_id: `eq.${timeseriesId}`,
      observed_at: `gte.${start.toISOString()}`,
      order: "observed_at.asc",
      limit: String(limit),
    });
    if (error) {
      throw new Error(error.message);
    }
    const rows = data ?? [];
    return json({
      timeseries_id: timeseriesId,
      window: windowLabel,
      start: start.toISOString(),
      end: end.toISOString(),
      count: rows.length,
      guideline,
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
    },
  });
}

async function getPollutantKey(timeseriesId: number): Promise<string | null> {
  const { data, error } = await postgrestRequest<any[]>("GET", "timeseries", {
    select: "id,phenomena(pollutant_label,notation,label)",
    id: `eq.${timeseriesId}`,
    limit: "1",
  });
  if (error || !data || data.length === 0) {
    return null;
  }
  const record = data[0];
  const phen = Array.isArray(record?.phenomena) ? record.phenomena[0] : record?.phenomena;
  const candidate = phen?.pollutant_label || phen?.notation || phen?.label;
  return normalizePollutant(candidate);
}

function normalizePollutant(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const lower = value.toLowerCase();
  if (lower.includes("pm2.5") || lower.includes("pm2_5") || lower.includes("pm25")) {
    return "pm2.5";
  }
  if (lower.includes("pm10")) {
    return "pm10";
  }
  if (lower.includes("no2") || lower.includes("nitrogen dioxide")) {
    return "no2";
  }
  if (lower.includes("o3") || lower.includes("ozone")) {
    return "o3";
  }
  if (lower.includes("so2") || lower.includes("sulphur dioxide") || lower.includes("sulfur dioxide")) {
    return "so2";
  }
  return lower.replace(/\s+/g, "");
}
