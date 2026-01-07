import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_STATION_LIKE = "Bristol";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

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
  const region = normalizeText(url.searchParams.get("region"));
  const stationLike = normalizeText(url.searchParams.get("station_like"))
    ?? (region ? null : DEFAULT_STATION_LIKE);
  const serviceId = normalizeText(url.searchParams.get("service_id"));
  const limit = parseLimit(url.searchParams.get("limit"), DEFAULT_LIMIT);

  try {
    const rows = await loadLatest({ region, stationLike, serviceId, limit });
    return json({
      region,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, 500);
  }
});

type LoadOptions = {
  region: string | null;
  stationLike: string | null;
  serviceId: string | null;
  limit: number;
};

async function loadLatest({ region, stationLike, serviceId, limit }: LoadOptions) {
  let query = supabase
    .from("timeseries")
    .select(
      "id,timeseries_ref,label,uom,last_value,last_value_at,station:stations!inner(id,station_ref,label,region),phenomenon:phenomena(id,label,notation,eionet_uri)",
    );

  if (region) {
    query = query.ilike("stations.region", `%${region}%`);
  }
  if (stationLike) {
    query = query.ilike("stations.label", `%${stationLike}%`);
  }
  if (serviceId) {
    query = query.eq("service_id", serviceId);
  }

  const { data, error } = await query.limit(limit);
  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).sort((a, b) => {
    const aStation = a.station?.label ?? "";
    const bStation = b.station?.label ?? "";
    const stationCompare = aStation.localeCompare(bStation);
    if (stationCompare !== 0) {
      return stationCompare;
    }
    const aPhenomenon = a.phenomenon?.label ?? "";
    const bPhenomenon = b.phenomenon?.label ?? "";
    return aPhenomenon.localeCompare(bPhenomenon);
  });
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

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}
