// @ts-nocheck
// Deployment touchpoint: change triggers edge deploy workflow.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const DEFAULT_STATION_LIKE = null;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10000;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")
  ?? Deno.env.get("SB_SUPABASE_URL")
  ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  ?? Deno.env.get("SB_SERVICE_ROLE_KEY")
  ?? "";
const UK_AQ_CORE_SCHEMA = Deno.env.get("UK_AQ_CORE_SCHEMA")
  ?? "uk_aq_core";

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
  table: string,
  params?: Record<string, string>,
  schema?: string,
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
    headers: postgrestHeaders(schema),
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
  const region = normalizeText(url.searchParams.get("region"));
  const pconCode = normalizeText(url.searchParams.get("pcon_code"));
  const stationLikeParam = normalizeText(url.searchParams.get("station_like"));
  const scopeParam = normalizeText(url.searchParams.get("scope"));
  const includeAll = scopeParam === "all" || stationLikeParam === "all";
  const stationLike = includeAll
    ? stationLikeParam && stationLikeParam !== "all"
      ? stationLikeParam
      : null
    : stationLikeParam ?? (region ? null : DEFAULT_STATION_LIKE);
  const connectorId = normalizeText(url.searchParams.get("connector_id"));
  const pollutant = normalizePollutant(url.searchParams.get("pollutant"));
  const limit = parseLimit(url.searchParams.get("limit"), DEFAULT_LIMIT);

  try {
    const rows = await loadLatest({ region, pconCode, stationLike, connectorId, pollutant, limit });
    return json({
      region,
      pcon_code: pconCode,
      pollutant,
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
  pconCode: string | null;
  stationLike: string | null;
  connectorId: string | null;
  pollutant: string | null;
  limit: number;
};

async function loadLatest({ region, pconCode, stationLike, connectorId, pollutant, limit }: LoadOptions) {
  const pollutantKey = normalizePollutant(pollutant);
  const useStationInner = Boolean(region || pconCode);
  const phenomenonSelect = pollutantKey
    ? "phenomenon:phenomena!inner(id,label,notation,eionet_uri,pollutant_label)"
    : "phenomenon:phenomena(id,label,notation,eionet_uri,pollutant_label)";
  const connectorSelect = "connector:connectors(id,connector_code,label,display_name,station_display_name_template)";
  const stationSelect =
    "station:stations(id,station_ref,label,station_name,region,la_code,la_version,pcon_code,pcon_version,connector_id,station_network_memberships(network_code,network_label,is_primary))";
  const stationSelectInner =
    "station:stations!inner(id,station_ref,label,station_name,region,la_code,la_version,pcon_code,pcon_version,connector_id,station_network_memberships(network_code,network_label,is_primary))";
  const selectBase =
    `id,timeseries_ref,label,uom,last_value,last_value_at,connector_id,${connectorSelect},${stationSelect},${phenomenonSelect}`;
  const selectStationInner =
    `id,timeseries_ref,label,uom,last_value,last_value_at,connector_id,${connectorSelect},${stationSelectInner},${phenomenonSelect}`;
  const baseParams: Record<string, string> = {
    select: useStationInner ? selectStationInner : selectBase,
    last_value: "gte.0",
    last_value_at: "not.is.null",
  };
  const pollutantFilter = buildPollutantFilter(pollutantKey);
  if (pollutantFilter) {
    baseParams["phenomena.or"] = pollutantFilter;
  }
  if (region) {
    baseParams["stations.region"] = `ilike.*${region}*`;
  }
  if (pconCode) {
    baseParams["stations.pcon_code"] = `eq.${pconCode}`;
  }
  if (connectorId) {
    baseParams.connector_id = `eq.${connectorId}`;
  }
  const fetchRows = async (extra: Record<string, string>, useStationInner = false) => {
    const { data, error } = await postgrestRequest<any[]>("GET", "timeseries", {
      ...baseParams,
      ...extra,
      select: useStationInner ? selectStationInner : baseParams.select,
      limit: String(limit),
    });
    if (error) {
      throw new Error(error.message);
    }
    return data ?? [];
  };

  let rows: any[] = [];
  if (!stationLike) {
    rows = await fetchRows({});
  } else {
    const match = `*${stationLike}*`;
    const [seriesResult, stationResult] = await Promise.all([
      fetchRows({ label: `ilike.${match}` }, useStationInner),
      fetchRows({ "stations.label": `ilike.${match}` }, true),
    ]);
    const combined = new Map<string, any>();
    for (const row of seriesResult ?? []) {
      combined.set(String(row.id), row);
    }
    for (const row of stationResult ?? []) {
      combined.set(String(row.id), row);
    }
    rows = Array.from(combined.values()).slice(0, limit);
  }

  const filtered = rows.filter(passesOutlierThreshold);

  return filtered.map((row) => {
    const pollutantLabel = resolvePhenomenonLabel(
      row.phenomenon?.pollutant_label,
      row.phenomenon?.label,
      row.phenomenon?.notation,
      row.phenomenon?.eionet_uri,
    );
    const connector = row.connector ?? null;
    return {
      ...row,
      connector_id: connector?.id ?? row.connector_id ?? null,
      connector_code: connector?.connector_code ?? null,
      connector_label: connector?.display_name ?? connector?.label ?? null,
      station_label: resolveStationLabel(row.station?.label, row.station?.station_ref, row.label),
      station_name: row.station?.station_name ?? null,
      display_name: formatDisplayName(
        connector?.station_display_name_template,
        row.station?.station_name,
        resolveStationLabel(row.station?.label, row.station?.station_ref, row.label),
        row.station?.station_ref,
      ),
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

function normalizePollutant(value: string | null): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  const compact = normalized.toLowerCase().replace(/[\s_]/g, "");
  if (compact === "pm25" || compact === "pm2.5") {
    return "pm2.5";
  }
  if (compact === "pm10") {
    return "pm10";
  }
  if (compact === "no2") {
    return "no2";
  }
  if (compact === "o3") {
    return "o3";
  }
  return normalized.toLowerCase();
}

function formatDisplayName(
  template: string | null | undefined,
  stationName: string | null | undefined,
  stationLabel: string | null | undefined,
  stationRef: string | number,
): string | null {
  const refText = stationRef !== null && stationRef !== undefined ? String(stationRef) : "";
  const fallback = formatFallbackDisplayName(stationName, stationLabel, refText);
  const effectiveTemplate = template?.trim();
  if (!effectiveTemplate) {
    return fallback;
  }
  const rendered = renderDisplayTemplate(effectiveTemplate, {
    station_name: stationName ?? "",
    station_label: stationLabel ?? "",
    station_ref: refText,
  });
  if (rendered) {
    return rendered;
  }
  return fallback;
}

function formatFallbackDisplayName(
  stationName: string | null | undefined,
  stationLabel: string | null | undefined,
  stationRef: string,
): string | null {
  const base = stationName ?? stationLabel ?? null;
  if (!base) {
    return stationRef || null;
  }
  if (!stationName) {
    return base;
  }
  const normalizedBase = base.toLowerCase();
  if (stationRef && normalizedBase.includes(stationRef.toLowerCase())) {
    return base;
  }
  return stationRef ? `${base} - ${stationRef}` : base;
}

function renderDisplayTemplate(
  template: string,
  tokens: Record<string, string>,
): string | null {
  const rendered = template.replace(/\{(station_name|station_label|station_ref)\}/g, (_, key) => {
    return tokens[key] ?? "";
  });
  const cleaned = rendered.replace(/\s+-\s+/g, " - ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned : null;
}

function buildPollutantFilter(pollutant: string | null): string | null {
  if (!pollutant) {
    return null;
  }
  const tokens = pollutantTokens(pollutant);
  const conditions: string[] = [];
  for (const token of tokens) {
    const escaped = token.replace(/,/g, "");
    conditions.push(`notation.ilike.${escaped}`);
    conditions.push(`pollutant_label.ilike.${escaped}`);
  }
  return `(${conditions.join(",")})`;
}

function pollutantTokens(pollutant: string): string[] {
  const compact = pollutant.toLowerCase().replace(/[\s_]/g, "");
  const tokens = new Set<string>([pollutant.toLowerCase()]);
  if (compact === "pm25" || compact === "pm2.5" || compact === "pm2-5") {
    tokens.add("pm2.5");
    tokens.add("pm25");
    tokens.add("pm2-5");
    tokens.add("pm2_5");
  }
  return Array.from(tokens);
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
  if (notation) {
    return notation;
  }
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

function passesOutlierThreshold(row: any): boolean {
  const rawValue = row?.last_value;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    return false;
  }
  const pollutant = normalizePollutant(
    row?.phenomenon?.notation
      ?? row?.phenomenon?.pollutant_label
      ?? row?.phenomenon?.label
      ?? row?.phenomenon_label
      ?? null,
  );
  if (!pollutant) {
    return true;
  }
  const thresholds: Record<string, { min: number; max: number }> = {
    "pm2.5": { min: 0, max: 500 },
    "pm25": { min: 0, max: 500 },
    "pm10": { min: 0, max: 600 },
  };
  const bounds = thresholds[pollutant];
  if (!bounds) {
    return true;
  }
  return value >= bounds.min && value <= bounds.max;
}
