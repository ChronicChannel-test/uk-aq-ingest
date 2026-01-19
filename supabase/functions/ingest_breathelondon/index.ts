// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type PollRequest = {
  api_key?: string;
  connector_id?: string;
  connector_code?: string;
  connector_label?: string;
  service_ref?: string;
  base_url?: string;
  species?: string[] | string;
  initial_days?: number;
  start_date?: string;
  window_hours?: number;
  sleep_seconds?: number;
  batch_size?: number;
  limit?: number;
  skip_stations?: boolean;
  dry_run?: boolean;
};

type ConnectorRow = {
  id: string;
  connector_code: string;
  label: string;
  service_url: string | null;
};

const DEFAULT_BASE_URL = "https://api.breathelondon-communities.org/api";
const DEFAULT_CONNECTOR_CODE = "breathelondon";
const DEFAULT_SERVICE_LABEL = "Breathe London";
const DEFAULT_USER_AGENT = "uk-air-quality-networks";
const DEFAULT_INITIAL_DAYS = 7;
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_SLEEP_SECONDS = 0.2;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const SPECIES_CONFIG: Record<
  string,
  { label: string; uom: string; eionet_uri: string; notation: string; pollutant_label: string }
> = {
  IPM25: {
    label: "PM2.5",
    uom: "ug/m3",
    eionet_uri: "breathelondon:pm2.5",
    notation: "PM2.5",
    pollutant_label: "pm2.5",
  },
  INO2: {
    label: "NO2",
    uom: "ug/m3",
    eionet_uri: "breathelondon:no2",
    notation: "NO2",
    pollutant_label: "no2",
  },
};

const UK_BBOX = {
  west: -11.0,
  south: 49.0,
  east: 2.0,
  north: 61.0,
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")
  ?? Deno.env.get("SB_SUPABASE_URL")
  ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  ?? Deno.env.get("SB_SERVICE_ROLE_KEY")
  ?? "";

const BREATHELONDON_API_KEY = Deno.env.get("BREATHELONDON_API_KEY") ?? "";
const BREATHELONDON_BASE_URL = (Deno.env.get("BREATHELONDON_BASE_URL") ?? DEFAULT_BASE_URL)
  .replace(/\/$/, "");
const BREATHELONDON_CONNECTOR_CODE = Deno.env.get("BREATHELONDON_CONNECTOR_CODE")
  ?? Deno.env.get("BREATHELONDON_CONNECTOR_REF")
  ?? Deno.env.get("BREATHELONDON_SERVICE_REF")
  ?? DEFAULT_CONNECTOR_CODE;
const BREATHELONDON_SERVICE_REF = Deno.env.get("BREATHELONDON_SERVICE_REF")
  ?? BREATHELONDON_CONNECTOR_CODE;
const BREATHELONDON_SERVICE_LABEL = Deno.env.get("BREATHELONDON_SERVICE_LABEL")
  ?? DEFAULT_SERVICE_LABEL;
const BREATHELONDON_USER_AGENT = Deno.env.get("BREATHELONDON_USER_AGENT")
  ?? DEFAULT_USER_AGENT;
const SB_UK_AQ_CRON_SECRET = Deno.env.get("SB_UK_AQ_CRON_SECRET") ?? "";

const REST_BASE_URL = SUPABASE_URL
  ? `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1`
  : "";

function postgrestHeaders(prefer?: string): Record<string, string> {
  const headers: Record<string, string> = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) {
    headers.Prefer = prefer;
  }
  return headers;
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

async function postgrestRequest<T>(
  method: string,
  table: string,
  params?: Record<string, string>,
  body?: unknown,
  prefer?: string,
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
    headers: postgrestHeaders(prefer),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload: unknown = null;
  if (resp.status !== 204) {
    const contentType = resp.headers.get("content-type") ?? "";
    payload = contentType.includes("application/json") ? await resp.json() : await resp.text();
  }
  if (!resp.ok) {
    const message = (payload as { message?: string; error_description?: string; error?: string })?.message
      ?? (payload as { error_description?: string })?.error_description
      ?? (payload as { error?: string })?.error
      ?? resp.statusText;
    return { data: null, error: { message: String(message) } };
  }
  return { data: payload as T, error: null };
}

function asString(value: unknown, fallback?: string): string | undefined {
  if (value === null || value === undefined) {
    return fallback;
  }
  const trimmed = String(value).trim();
  return trimmed ? trimmed : fallback;
}

function asNumber(value: unknown, fallback?: number): number | undefined {
  if (value === null || value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoolean(value: unknown, fallback?: boolean): boolean | undefined {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeListSensors(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload) && payload.length > 0 && Array.isArray(payload[0])) {
    payload = payload[0];
  }
  if (Array.isArray(payload)) {
    return payload.filter((row) => row && typeof row === "object") as Record<string, unknown>[];
  }
  return [];
}

function coerceFloat(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function maybeSwapCoords(lon: number | null, lat: number | null): [number | null, number | null] {
  if (lon === null || lat === null) {
    return [lon, lat];
  }
  const swapped = (
    UK_BBOX.south <= lon && lon <= UK_BBOX.north
    && UK_BBOX.west <= lat && lat <= UK_BBOX.east
    && !(UK_BBOX.west <= lon && lon <= UK_BBOX.east)
    && !(UK_BBOX.south <= lat && lat <= UK_BBOX.north)
  );
  if (swapped) {
    return [lat, lon];
  }
  return [lon, lat];
}

function stationGeometry(lon: number | null, lat: number | null): string | null {
  if (lon === null || lat === null) {
    return null;
  }
  return `SRID=4326;POINT(${lon} ${lat})`;
}

function stationMetadataAttributes(station: Record<string, unknown>): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  const fields: Array<[string, string]> = [
    ["Enabled", "enabled"],
    ["SiteActive", "site_active"],
    ["OrganisationName", "organisation_name"],
    ["SponsorName", "sponsor_name"],
    ["DeviceCode", "device_code"],
    ["SiteDescription", "site_description"],
    ["SitePhotoURL", "site_photo_url"],
    ["BatteryStatus", "battery_status"],
    ["BatteryPercentage", "battery_percentage"],
    ["SignalStrength", "signal_strength"],
    ["SensorsHealthStatus", "sensors_health_status"],
    ["OverallStatus", "overall_status"],
    ["PowerTag", "power_tag"],
    ["OtherTags", "other_tags"],
    ["Indoor", "indoor"],
    ["HeadHeight", "head_height"],
    ["ToRoad", "to_road"],
  ];
  for (const [source, target] of fields) {
    if (station[source] !== undefined && station[source] !== null) {
      attributes[target] = station[source];
    }
  }
  return attributes;
}

function normalizeStationPayload(
  station: Record<string, unknown>,
  connectorId: string,
  serviceRef: string,
): { row: Record<string, unknown>; metadata: Record<string, unknown> } {
  const siteCode = asString(station.SiteCode) ?? null;
  const siteName = asString(station.SiteName);
  const lon = coerceFloat(station.Longitude);
  const lat = coerceFloat(station.Latitude);
  const [lonVal, latVal] = maybeSwapCoords(lon, lat);

  const row = {
    station_ref: siteCode,
    service_ref: serviceRef,
    label: siteName ?? siteCode ?? "Breathe London Station",
    station_name: siteName ?? null,
    station_type: asString(station.SiteClassification) ?? null,
    station_exposure: asString(station.SiteLocationType) ?? null,
    region: asString(station.SiteGroup) ?? null,
    geometry: stationGeometry(lonVal, latVal),
    first_seen_at: asString(station.StartDate) ?? null,
    last_seen_at: asString(station.LastCommunication) ?? null,
    removed_at: asString(station.EndDate) ?? null,
    connector_id: connectorId,
  };
  return { row, metadata: stationMetadataAttributes(station) };
}

function parseSpeciesList(value: string | string[] | undefined | null): string[] {
  const raw = Array.isArray(value) ? value.join(",") : (value ?? "");
  const items = raw.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean);
  return items.filter((item) => Object.hasOwn(SPECIES_CONFIG, item));
}

function parseStartDate(value: string | undefined | null): Date | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const hasTime = trimmed.includes("T") || trimmed.includes(" ");
  if (!hasTime) {
    const parsed = Date.parse(`${trimmed}T00:00:00Z`);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }
  let candidate = trimmed;
  if (candidate.includes(" ") && !candidate.includes("T")) {
    candidate = candidate.replace(" ", "T");
  }
  if (!candidate.endsWith("Z") && !candidate.includes("+")) {
    candidate = `${candidate}Z`;
  }
  const parsed = Date.parse(candidate);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function floorToHour(value: Date): Date {
  return new Date(Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate(),
    value.getUTCHours(),
    0,
    0,
    0,
  ));
}

function formatClarityTimestamp(value: Date): string {
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${weekdays[value.getUTCDay()]} ${pad(value.getUTCDate())} ${months[value.getUTCMonth()]} ${value.getUTCFullYear()} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())} GMT`;
}

function parseObservationTimestamp(value: unknown): string | null {
  const text = asString(value);
  if (!text) {
    return null;
  }
  const candidate = text.endsWith("Z") || text.includes("+") ? text : text.replace(" ", "T") + "Z";
  const parsed = Date.parse(candidate);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

function quotePostgrestValue(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function postgrestIn(values: string[]): string {
  return `in.(${values.map(quotePostgrestValue).join(",")})`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { headers, signal: controller.signal });
      if (RETRYABLE_STATUS.has(resp.status) && attempt < 3) {
        await sleep(Math.min(30_000, 2 ** attempt * 1000));
        continue;
      }
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${text}`);
      }
      return await resp.json();
    } finally {
      clearTimeout(timeout);
    }
  }
  return [];
}

async function listSensors(baseUrl: string, apiKey: string): Promise<Record<string, unknown>[]> {
  const url = new URL(`${baseUrl}/ListSensors`);
  url.searchParams.set("key", apiKey);
  const payload = await fetchJson(url.toString(), { "User-Agent": BREATHELONDON_USER_AGENT });
  return normalizeListSensors(payload);
}

async function getClarityData(
  baseUrl: string,
  apiKey: string,
  siteCode: string,
  species: string,
  startTime: Date,
  endTime: Date,
): Promise<unknown> {
  const start = encodeURIComponent(formatClarityTimestamp(startTime));
  const end = encodeURIComponent(formatClarityTimestamp(endTime));
  const url = new URL(
    `${baseUrl}/getClarityData/${siteCode}/${species}/${start}/${end}/Hourly`,
  );
  url.searchParams.set("key", apiKey);
  return await fetchJson(url.toString(), { "User-Agent": BREATHELONDON_USER_AGENT });
}

async function loadConnector(
  connectorId: string | undefined,
  connectorCode: string,
  connectorLabel: string,
  serviceUrl: string,
): Promise<ConnectorRow | null> {
  const select = "id,connector_code,label,service_url";
  if (connectorId) {
    const { data } = await postgrestRequest<ConnectorRow[]>("GET", "connectors", {
      select,
      id: `eq.${connectorId}`,
      limit: "1",
    });
    if (data && data[0]) {
      return data[0];
    }
  }
  const { data: existing } = await postgrestRequest<ConnectorRow[]>("GET", "connectors", {
    select,
    connector_code: `eq.${connectorCode}`,
    limit: "1",
  });
  if (existing && existing[0]) {
    return existing[0];
  }
  await postgrestRequest(
    "POST",
    "connectors",
    { on_conflict: "connector_code" },
    [
      {
        connector_code: connectorCode,
        label: connectorLabel,
        display_name: connectorLabel,
        service_url: serviceUrl,
        stations_bbox_supported: false,
        timeseries_station_filter_supported: false,
        poll_enabled: true,
        poll_interval_minutes: 15,
        poll_window_hours: 1,
      },
    ],
    "resolution=merge-duplicates,return=minimal",
  );
  const { data } = await postgrestRequest<ConnectorRow[]>("GET", "connectors", {
    select,
    connector_code: `eq.${connectorCode}`,
    limit: "1",
  });
  return data && data[0] ? data[0] : null;
}

async function upsertStations(rows: Record<string, unknown>[]): Promise<number> {
  const payload = rows.filter((row) => row.station_ref);
  if (!payload.length) {
    return 0;
  }
  await postgrestRequest(
    "POST",
    "stations",
    { on_conflict: "connector_id,service_ref,station_ref" },
    payload,
    "resolution=merge-duplicates,return=minimal",
  );
  return payload.length;
}

async function fetchStationsFromDb(
  connectorId: string,
  serviceRef: string,
  limit?: number,
): Promise<Array<{ id: number; station_ref: string; station_name: string | null; label: string | null }>> {
  const rows: Array<{ id: number; station_ref: string; station_name: string | null; label: string | null }> = [];
  const pageSize = 1000;
  const maxRows = limit && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : null;
  let offset = 0;

  while (true) {
    if (maxRows !== null && rows.length >= maxRows) {
      break;
    }
    const remaining = maxRows !== null ? maxRows - rows.length : pageSize;
    const pageLimit = Math.min(pageSize, remaining);
    if (pageLimit <= 0) {
      break;
    }
    const { data, error } = await postgrestRequest<
      Array<{ id: number; station_ref: string; station_name: string | null; label: string | null }>
    >(
      "GET",
      "stations",
      {
        select: "id,station_ref,station_name,label",
        connector_id: `eq.${connectorId}`,
        service_ref: `eq.${serviceRef}`,
        order: "station_ref.asc",
        limit: String(pageLimit),
        offset: String(offset),
      },
    );
    if (error) {
      throw new Error(`Failed to load stations from Supabase: ${error.message}`);
    }
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < pageLimit) {
      break;
    }
    offset += pageLimit;
  }

  return rows;
}

async function fetchStationIdsByRef(
  connectorId: string,
  serviceRef: string,
  stationRefs: string[],
): Promise<Record<string, number>> {
  const refs = stationRefs.filter(Boolean);
  if (!refs.length) {
    return {};
  }
  const mapping: Record<string, number> = {};
  for (let idx = 0; idx < refs.length; idx += 200) {
    const chunk = refs.slice(idx, idx + 200);
    const { data } = await postgrestRequest<Array<{ id: number; station_ref: string }>>(
      "GET",
      "stations",
      {
        select: "id,station_ref",
        connector_id: `eq.${connectorId}`,
        service_ref: `eq.${serviceRef}`,
        station_ref: postgrestIn(chunk),
      },
    );
    for (const row of data ?? []) {
      mapping[String(row.station_ref)] = Number(row.id);
    }
  }
  return mapping;
}

async function fetchStationMetadata(
  stationIds: number[],
): Promise<Record<number, Record<string, unknown>>> {
  if (!stationIds.length) {
    return {};
  }
  const metadata: Record<number, Record<string, unknown>> = {};
  for (let idx = 0; idx < stationIds.length; idx += 200) {
    const chunk = stationIds.slice(idx, idx + 200).map(String);
    const { data } = await postgrestRequest<Array<{ station_id: number; attributes: Record<string, unknown> }>>(
      "GET",
      "station_metadata",
      {
        select: "station_id,attributes",
        station_id: postgrestIn(chunk),
      },
    );
    for (const row of data ?? []) {
      if (row && row.attributes && typeof row.attributes === "object") {
        metadata[Number(row.station_id)] = row.attributes;
      }
    }
  }
  return metadata;
}

async function upsertStationMetadata(
  attributesByStation: Record<number, Record<string, unknown>>,
): Promise<number> {
  const stationIds = Object.keys(attributesByStation).map(Number);
  if (!stationIds.length) {
    return 0;
  }
  const existing = await fetchStationMetadata(stationIds);
  const rows: Record<string, unknown>[] = [];
  const timestamp = new Date().toISOString();
  for (const stationId of stationIds) {
    const merged = { ...(existing[stationId] ?? {}), ...(attributesByStation[stationId] ?? {}) };
    if (Object.keys(merged).length === 0) {
      continue;
    }
    rows.push({ station_id: stationId, attributes: merged, updated_at: timestamp });
  }
  if (!rows.length) {
    return 0;
  }
  await postgrestRequest(
    "POST",
    "station_metadata",
    { on_conflict: "station_id" },
    rows,
    "resolution=merge-duplicates,return=minimal",
  );
  return rows.length;
}

async function fetchPhenomenaIds(
  connectorId: string,
  speciesList: string[],
): Promise<Record<string, number>> {
  if (!speciesList.length) {
    return {};
  }
  const eionetUris = speciesList.map((species) => SPECIES_CONFIG[species].eionet_uri);
  const { data } = await postgrestRequest<Array<{ id: number; eionet_uri: string }>>(
    "GET",
    "phenomena",
    {
      select: "id,eionet_uri",
      connector_id: `eq.${connectorId}`,
      eionet_uri: postgrestIn(eionetUris),
    },
  );
  const mapping: Record<string, number> = {};
  for (const row of data ?? []) {
    mapping[String(row.eionet_uri)] = Number(row.id);
  }
  return mapping;
}

async function upsertPhenomena(connectorId: string, speciesList: string[]): Promise<Record<string, number>> {
  const payload = speciesList.map((species) => {
    const config = SPECIES_CONFIG[species];
    return {
      connector_id: connectorId,
      label: config.label,
      eionet_uri: config.eionet_uri,
      notation: config.notation,
      pollutant_label: config.pollutant_label,
    };
  });
  await postgrestRequest(
    "POST",
    "phenomena",
    { on_conflict: "connector_id,eionet_uri" },
    payload,
    "resolution=merge-duplicates,return=minimal",
  );
  return await fetchPhenomenaIds(connectorId, speciesList);
}

async function upsertTimeseries(rows: Record<string, unknown>[]): Promise<number> {
  if (!rows.length) {
    return 0;
  }
  await postgrestRequest(
    "POST",
    "timeseries",
    { on_conflict: "connector_id,service_ref,timeseries_ref" },
    rows,
    "resolution=merge-duplicates,return=minimal",
  );
  return rows.length;
}

async function fetchTimeseriesIds(
  connectorId: string,
  serviceRef: string,
  timeseriesRefs: string[],
): Promise<Record<string, number>> {
  const refs = timeseriesRefs.filter(Boolean);
  if (!refs.length) {
    return {};
  }
  const mapping: Record<string, number> = {};
  for (let idx = 0; idx < refs.length; idx += 200) {
    const chunk = refs.slice(idx, idx + 200);
    const { data } = await postgrestRequest<Array<{ id: number; timeseries_ref: string }>>(
      "GET",
      "timeseries",
      {
        select: "id,timeseries_ref",
        connector_id: `eq.${connectorId}`,
        service_ref: `eq.${serviceRef}`,
        timeseries_ref: postgrestIn(chunk),
      },
    );
    for (const row of data ?? []) {
      mapping[String(row.timeseries_ref)] = Number(row.id);
    }
  }
  return mapping;
}

async function fetchCheckpoints(
  stationIds: number[],
  speciesList: string[],
): Promise<Record<string, Record<string, unknown>>> {
  if (!stationIds.length || !speciesList.length) {
    return {};
  }
  const checkpoints: Record<string, Record<string, unknown>> = {};
  for (let idx = 0; idx < stationIds.length; idx += 200) {
    const chunk = stationIds.slice(idx, idx + 200).map(String);
    const { data } = await postgrestRequest<Array<Record<string, unknown>>>(
      "GET",
      "breathelondon_timeseries_checkpoints",
      {
        select: "station_id,species,timeseries_id,last_observed_at,last_fetch_at,last_error",
        station_id: postgrestIn(chunk),
        species: postgrestIn(speciesList),
      },
    );
    for (const row of data ?? []) {
      const stationId = Number(row.station_id);
      const species = String(row.species);
      if (!Number.isFinite(stationId) || !species) {
        continue;
      }
      checkpoints[`${stationId}:${species}`] = row;
    }
  }
  return checkpoints;
}

async function upsertCheckpoints(rows: Record<string, unknown>[]): Promise<number> {
  if (!rows.length) {
    return 0;
  }
  await postgrestRequest(
    "POST",
    "breathelondon_timeseries_checkpoints",
    { on_conflict: "station_id,species" },
    rows,
    "resolution=merge-duplicates,return=minimal",
  );
  return rows.length;
}

async function upsertObservations(rows: Record<string, unknown>[]): Promise<number> {
  if (!rows.length) {
    return 0;
  }
  await postgrestRequest(
    "POST",
    "observations",
    { on_conflict: "timeseries_id,observed_at" },
    rows,
    "resolution=merge-duplicates,return=minimal",
  );
  return rows.length;
}

async function updateTimeseriesLastValues(rows: Array<{ id: number; last_value: number; last_value_at: string }>): Promise<number> {
  let updated = 0;
  for (const row of rows) {
    await postgrestRequest(
      "PATCH",
      "timeseries",
      { id: `eq.${row.id}` },
      { last_value: row.last_value, last_value_at: row.last_value_at },
      "return=minimal",
    );
    updated += 1;
  }
  return updated;
}

function extractObservations(
  payload: unknown,
  timeseriesId: number,
): { rows: Record<string, unknown>[]; lastObserved: string | null; lastValue: number | null } {
  const rows: Record<string, unknown>[] = [];
  let lastObserved: string | null = null;
  let lastValue: number | null = null;
  if (Array.isArray(payload) && payload.length > 0 && Array.isArray(payload[0])) {
    payload = payload[0];
  }
  if (!Array.isArray(payload)) {
    return { rows, lastObserved, lastValue };
  }
  for (const entry of payload) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const observedAt = parseObservationTimestamp(entry.DateTime);
    const value = coerceFloat(entry.ScaledValue);
    if (!observedAt || value === null) {
      continue;
    }
    rows.push({ timeseries_id: timeseriesId, observed_at: observedAt, value });
    if (!lastObserved || observedAt > lastObserved) {
      lastObserved = observedAt;
      lastValue = value;
    }
  }
  return { rows, lastObserved, lastValue };
}

function chunk<T>(values: T[], size: number): T[][] {
  if (size <= 0) {
    return [values];
  }
  const chunks: T[][] = [];
  for (let idx = 0; idx < values.length; idx += size) {
    chunks.push(values.slice(idx, idx + size));
  }
  return chunks;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const authResponse = requireCronSecret(req);
  if (authResponse) {
    return authResponse;
  }

  const errors: string[] = [];
  let status = 200;
  let responsePayload: Record<string, unknown> = {};

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      status = 500;
      responsePayload = { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." };
    } else if (!BREATHELONDON_API_KEY) {
      status = 500;
      responsePayload = { error: "Missing BREATHELONDON_API_KEY." };
    } else {
      const payload = await req.json().catch(() => ({}));
      const request = payload as PollRequest;

      const connectorId = asString(request.connector_id);
      const connectorCode = asString(request.connector_code) ?? BREATHELONDON_CONNECTOR_CODE;
      const connectorLabel = asString(request.connector_label) ?? BREATHELONDON_SERVICE_LABEL;
      const serviceRef = asString(request.service_ref) ?? BREATHELONDON_SERVICE_REF;
      const baseUrl = asString(request.base_url) ?? BREATHELONDON_BASE_URL;
      const speciesList = parseSpeciesList(request.species ?? "IPM25,INO2");
      const initialDays = asNumber(request.initial_days, DEFAULT_INITIAL_DAYS) ?? DEFAULT_INITIAL_DAYS;
      const windowHours = asNumber(request.window_hours, DEFAULT_WINDOW_HOURS) ?? DEFAULT_WINDOW_HOURS;
      const sleepSeconds = asNumber(request.sleep_seconds, DEFAULT_SLEEP_SECONDS) ?? DEFAULT_SLEEP_SECONDS;
      const batchSize = asNumber(request.batch_size, DEFAULT_BATCH_SIZE) ?? DEFAULT_BATCH_SIZE;
      const limit = asNumber(request.limit);
      const skipStations = asBoolean(request.skip_stations, false) ?? false;
      const dryRun = asBoolean(request.dry_run, false) ?? false;
      const apiKey = asString(request.api_key) ?? BREATHELONDON_API_KEY;
      const startDateOverride = parseStartDate(asString(request.start_date));

      if (!speciesList.length) {
        status = 400;
        responsePayload = { error: "No valid species specified." };
      } else {
        const connector = await loadConnector(connectorId, connectorCode, connectorLabel, baseUrl);
        if (!connector) {
          status = 500;
          responsePayload = { error: "Failed to resolve connector id." };
        } else {
          let stationRows: Record<string, unknown>[] = [];
          let stationIdMap: Record<string, number> = {};

          if (skipStations) {
            const stations = await fetchStationsFromDb(connector.id, serviceRef, limit);
            for (const station of stations) {
              const stationRef = asString(station.station_ref);
              if (!stationRef) {
                continue;
              }
              stationRows.push({
                station_ref: stationRef,
                station_name: asString(station.station_name) ?? null,
                label: asString(station.label) ?? stationRef,
              });
              const stationId = Number(station.id);
              if (Number.isFinite(stationId)) {
                stationIdMap[stationRef] = stationId;
              }
            }
          } else {
            const sensors = await listSensors(baseUrl, apiKey);
            const trimmedSensors = limit ? sensors.slice(0, Math.max(0, limit)) : sensors;
            if (!trimmedSensors.length) {
              responsePayload = { warning: "No sensors returned from Breathe London." };
            } else {
              const metadataByRef: Record<string, Record<string, unknown>> = {};
              for (const sensor of trimmedSensors) {
                const { row, metadata } = normalizeStationPayload(sensor, connector.id, serviceRef);
                if (!row.station_ref) {
                  continue;
                }
                stationRows.push(row);
                if (metadata && Object.keys(metadata).length > 0) {
                  metadataByRef[String(row.station_ref)] = metadata;
                }
              }

              if (!dryRun) {
                await upsertStations(stationRows);
                if (Object.keys(metadataByRef).length > 0) {
                  const metadataStationIds = await fetchStationIdsByRef(
                    connector.id,
                    serviceRef,
                    Object.keys(metadataByRef),
                  );
                  const attributesByStation: Record<number, Record<string, unknown>> = {};
                  for (const [ref, attrs] of Object.entries(metadataByRef)) {
                    const stationId = metadataStationIds[ref];
                    if (stationId) {
                      attributesByStation[stationId] = attrs;
                    }
                  }
                  await upsertStationMetadata(attributesByStation);
                }
              }
            }
          }

          if (!stationRows.length) {
            responsePayload = {
              warning: skipStations
                ? "No Breathe London stations found in Supabase."
                : "No sensors returned from Breathe London.",
            };
          } else if (skipStations) {
            if (!Object.keys(stationIdMap).length) {
              responsePayload = { warning: "No station ids resolved for Breathe London." };
            }
          } else {
            stationIdMap = await fetchStationIdsByRef(
              connector.id,
              serviceRef,
              stationRows.map((row) => String(row.station_ref)),
            );
          }

          if (!Object.keys(stationIdMap).length) {
            if (!responsePayload.warning) {
              responsePayload = { warning: "No station ids resolved for Breathe London." };
            }
          } else {
              const phenomenonIds = dryRun
                ? await fetchPhenomenaIds(connector.id, speciesList)
                : await upsertPhenomena(connector.id, speciesList);

              const timeseriesRows: Record<string, unknown>[] = [];
              for (const row of stationRows) {
                const stationRef = String(row.station_ref);
                const stationId = stationIdMap[stationRef];
                if (!stationId) {
                  continue;
                }
                const stationName = asString(row.station_name) ?? asString(row.label) ?? stationRef;
                for (const species of speciesList) {
                  const config = SPECIES_CONFIG[species];
                  timeseriesRows.push({
                    timeseries_ref: `${stationRef}:${species}`,
                    label: `${stationName} ${config.label}`,
                    uom: config.uom,
                    station_id: stationId,
                    service_ref: serviceRef,
                    connector_id: connector.id,
                    phenomenon_id: phenomenonIds[config.eionet_uri],
                    extras: { site_code: stationRef, species },
                  });
                }
              }
              if (!dryRun) {
                await upsertTimeseries(timeseriesRows);
              }
              const timeseriesIdMap = await fetchTimeseriesIds(
                connector.id,
                serviceRef,
                timeseriesRows.map((row) => String(row.timeseries_ref)),
              );

              const stationIds = Array.from(new Set(Object.values(stationIdMap)));
              const checkpoints = await fetchCheckpoints(stationIds, speciesList);

              const now = floorToHour(new Date());
              const timeseriesUpdates: Array<{ id: number; last_value: number; last_value_at: string }> = [];
              const checkpointRows: Record<string, unknown>[] = [];
              let observationsUpserted = 0;

              for (const row of stationRows) {
                const stationRef = String(row.station_ref);
                const stationId = stationIdMap[stationRef];
                if (!stationId) {
                  continue;
                }
                for (const species of speciesList) {
                  const timeseriesRef = `${stationRef}:${species}`;
                  const timeseriesId = timeseriesIdMap[timeseriesRef];
                  if (!timeseriesId) {
                    continue;
                  }
                  const checkpointKey = `${stationId}:${species}`;
                  const checkpoint = checkpoints[checkpointKey] ?? {};
                  const checkpointObserved = parseObservationTimestamp(checkpoint.last_observed_at);
                  const checkpointDate = checkpointObserved ? new Date(checkpointObserved) : null;
                  let lastObserved = checkpointObserved ?? null;
                  let lastValue: number | null = null;
                  let lastError: string | null = null;

                  let startTime: Date;
                  if (checkpointDate) {
                    startTime = checkpointDate;
                  } else if (startDateOverride) {
                    startTime = startDateOverride;
                  } else {
                    startTime = new Date(now.getTime() - Math.max(initialDays, 1) * 24 * 60 * 60 * 1000);
                  }
                  startTime = floorToHour(startTime);
                  if (startTime >= now) {
                    continue;
                  }
                  const windowMs = Math.max(windowHours, 1) * 60 * 60 * 1000;
                  let cursor = startTime;

                  while (cursor < now) {
                    const endTime = new Date(Math.min(cursor.getTime() + windowMs, now.getTime()));
                    try {
                      const payload = await getClarityData(baseUrl, apiKey, stationRef, species, cursor, endTime);
                      const { rows, lastObserved: windowLast, lastValue: windowValue } = extractObservations(
                        payload,
                        timeseriesId,
                      );
                      if (rows.length) {
                        if (!dryRun) {
                          for (const batch of chunk(rows, batchSize)) {
                            observationsUpserted += await upsertObservations(batch);
                          }
                        }
                      }
                      if (windowLast && (!lastObserved || windowLast > lastObserved)) {
                        lastObserved = windowLast;
                        lastValue = windowValue;
                      }
                    } catch (error) {
                      lastError = error instanceof Error ? error.message : String(error);
                      break;
                    }
                    cursor = endTime;
                    if (sleepSeconds && sleepSeconds > 0) {
                      await sleep(sleepSeconds * 1000);
                    }
                  }

                  if (lastObserved && lastValue !== null) {
                    timeseriesUpdates.push({ id: timeseriesId, last_value: lastValue, last_value_at: lastObserved });
                  }

                  checkpointRows.push({
                    station_id: stationId,
                    species,
                    timeseries_id: timeseriesId,
                    last_observed_at: lastObserved,
                    last_fetch_at: new Date().toISOString(),
                    last_error: lastError,
                    updated_at: new Date().toISOString(),
                  });
                }
              }

              let timeseriesUpdated = 0;
              let checkpointsUpserted = 0;
              if (!dryRun) {
                if (timeseriesUpdates.length) {
                  timeseriesUpdated = await updateTimeseriesLastValues(timeseriesUpdates);
                }
                if (checkpointRows.length) {
                  checkpointsUpserted = await upsertCheckpoints(checkpointRows);
                }
              }

              responsePayload = {
                connector_id: connector.id,
                stations: stationRows.length,
                species: speciesList,
                observations_upserted: observationsUpserted,
                timeseries_updated: timeseriesUpdated,
                checkpoints_upserted: checkpointsUpserted,
                dry_run: dryRun,
                errors,
              };
            }
          }
        }
      }
  } catch (error) {
    status = 500;
    responsePayload = {
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return new Response(JSON.stringify(responsePayload, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
});
