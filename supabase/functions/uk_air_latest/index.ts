// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const DEFAULT_STATION_LIKE = "Bristol";
const DEFAULT_LIMIT = 1000;
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
  const buildQuery = () => {
    let query = supabase
    .from("timeseries")
    .select(
      "id,timeseries_ref,label,uom,last_value,last_value_at,station:stations(id,station_ref,label,region),phenomenon:phenomena(id,label,notation,eionet_uri,pollutant_label)",
    );

    if (region) {
      query = query.ilike("region", `%${region}%`, { foreignTable: "stations" });
    }
    if (serviceId) {
      query = query.eq("service_id", serviceId);
    }
    return query;
  };

  let rows: any[] = [];
  if (!stationLike) {
    const { data, error } = await buildQuery().limit(limit);
    if (error) {
      throw new Error(error.message);
    }
    rows = data ?? [];
  } else {
    const match = `%${stationLike}%`;
    const [seriesResult, stationResult] = await Promise.all([
      buildQuery().ilike("label", match).limit(limit),
      buildQuery().ilike("label", match, { foreignTable: "stations" }).limit(limit),
    ]);
    if (seriesResult.error) {
      throw new Error(seriesResult.error.message);
    }
    if (stationResult.error) {
      throw new Error(stationResult.error.message);
    }
    const combined = new Map<string, any>();
    for (const row of seriesResult.data ?? []) {
      combined.set(String(row.id), row);
    }
    for (const row of stationResult.data ?? []) {
      combined.set(String(row.id), row);
    }
    rows = Array.from(combined.values()).slice(0, limit);
  }

  return rows.map((row) => {
    const pollutantLabel = resolvePhenomenonLabel(
      row.phenomenon?.pollutant_label,
      row.phenomenon?.label,
      row.phenomenon?.notation,
      row.phenomenon?.eionet_uri,
    );
    return {
      ...row,
      station_label: resolveStationLabel(row.station?.label, row.station?.station_ref, row.label),
      phenomenon_label: pollutantLabel,
      pollutant_label: pollutantLabel,
      uom_display: formatUnit(row.uom),
    };
  }).sort((a, b) => {
    const aPollutant = a.phenomenon?.label ?? a.phenomenon_label ?? "";
    const bPollutant = b.phenomenon?.label ?? b.phenomenon_label ?? "";
    const pollutantCompare = aPollutant.localeCompare(bPollutant);
    if (pollutantCompare !== 0) {
      return pollutantCompare;
    }
    const aStation = a.station?.label ?? a.station_label ?? "";
    const bStation = b.station?.label ?? b.station_label ?? "";
    return aStation.localeCompare(bStation);
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

function deriveStationLabel(label: string | null): string | null {
  if (!label) {
    return null;
  }
  const separator = label.includes(" - ") ? " - " : "-";
  const parts = label.split(separator).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) {
    return label;
  }
  if (parts.length > 1 && (looksLikePollutantUri(parts[0]) || looksLikeUrl(parts[0]))) {
    return parts[parts.length - 1];
  }
  if (parts.length === 1 && looksLikeUrl(parts[0])) {
    return null;
  }
  return parts[0];
}

function resolveStationLabel(
  stationLabel: string | null | undefined,
  stationRef: string | null | undefined,
  seriesLabel: string | null,
): string | null {
  return stationLabel
    ?? deriveStationLabel(seriesLabel)
    ?? stationRef
    ?? null;
}

function resolvePhenomenonLabel(
  pollutantLabel: string | null | undefined,
  label: string | null | undefined,
  notation: string | null | undefined,
  eionetUri: string | null | undefined,
): string | null {
  if (pollutantLabel) {
    return pollutantLabel;
  }
  if (label) {
    return label;
  }
  if (notation) {
    return notation;
  }
  if (eionetUri) {
    return eionetUri.split("/").filter(Boolean).pop() ?? null;
  }
  return null;
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function looksLikePollutantUri(value: string): boolean {
  return /dd\.eionet\.europa\.eu\/vocabulary\/aq\/pollutant\//i.test(value);
}

function formatUnit(unit: string | null): string | null {
  if (!unit) {
    return null;
  }
  const trimmed = unit.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.toLowerCase().replace(/µ/g, "u");
  if (normalized.includes("ug") && /m\s*[-^]?\s*3/.test(normalized)) {
    return "µg/m³";
  }
  return trimmed;
}
