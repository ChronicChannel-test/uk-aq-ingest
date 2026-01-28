// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type PollRequest = {
  connector_code?: string;
  station_refs?: string[];
  window_hours?: number;
  dry_run?: boolean;
};

type ConnectorRow = {
  id: string;
  connector_code: string;
  label: string;
  service_url: string | null;
  overwrite_station_name?: boolean | null;
};

type ErrorLogEntry = {
  severity: "error" | "warn";
  message: string;
  context?: Record<string, unknown> | null;
  connector_id?: string | number | null;
};

const DEFAULT_BASE_URL = "https://api.airgradient.com/public/api/v1";
const DEFAULT_CONNECTOR_CODE = "airgradient";
const DEFAULT_SERVICE_LABEL = "AirGradient";
const DEFAULT_USER_AGENT = "uk-air-quality-networks";
const DEFAULT_WINDOW_HOURS = 1;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")
  ?? Deno.env.get("SB_SUPABASE_URL")
  ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  ?? Deno.env.get("SB_SERVICE_ROLE_KEY")
  ?? "";
const UK_AQ_CORE_SCHEMA = Deno.env.get("UK_AQ_CORE_SCHEMA")
  ?? "uk_aq_core";
const UK_AQ_RAW_SCHEMA = Deno.env.get("UK_AQ_RAW_SCHEMA")
  ?? "uk_aq_raw";
const SB_UK_AQ_CRON_SECRET = Deno.env.get("SB_UK_AQ_CRON_SECRET") ?? "";

const AIRGRADIENT_BASE_URL = (Deno.env.get("AIRGRADIENT_BASE_URL") ?? DEFAULT_BASE_URL)
  .replace(/\/$/, "");
const AIRGRADIENT_LOCATIONS_PATH = Deno.env.get("AIRGRADIENT_LOCATIONS_PATH") ?? "/locations";
const AIRGRADIENT_MEASUREMENTS_PATH_TEMPLATE = Deno.env.get(
  "AIRGRADIENT_MEASUREMENTS_PATH_TEMPLATE",
) ?? "/locations/{location_id}/measures";
const AIRGRADIENT_CONNECTOR_CODE = Deno.env.get("AIRGRADIENT_CONNECTOR_CODE")
  ?? DEFAULT_CONNECTOR_CODE;
const AIRGRADIENT_SERVICE_REF = Deno.env.get("AIRGRADIENT_SERVICE_REF")
  ?? AIRGRADIENT_CONNECTOR_CODE;
const AIRGRADIENT_SERVICE_LABEL = Deno.env.get("AIRGRADIENT_SERVICE_LABEL")
  ?? DEFAULT_SERVICE_LABEL;
const AIRGRADIENT_USER_AGENT = Deno.env.get("AIRGRADIENT_USER_AGENT")
  ?? DEFAULT_USER_AGENT;
const AIRGRADIENT_API_KEY = Deno.env.get("AIRGRADIENT_API_KEY") ?? "";
const AIRGRADIENT_API_KEY_PARAM = Deno.env.get("AIRGRADIENT_API_KEY_PARAM") ?? "api_key";
const AIRGRADIENT_API_KEY_HEADER = Deno.env.get("AIRGRADIENT_API_KEY_HEADER") ?? "X-API-KEY";

const REST_BASE_URL = SUPABASE_URL
  ? `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1`
  : "";

const AIRGRADIENT_PHENOMENA: Record<
  string,
  { eionet_uri: string; label: string; notation: string; pollutant_label: string; uom: string }
> = {
  "pm1": {
    eionet_uri: "airgradient:pm1",
    label: "PM1",
    notation: "PM1",
    pollutant_label: "pm1",
    uom: "ug/m3",
  },
  "pm2.5": {
    eionet_uri: "airgradient:pm2.5",
    label: "PM2.5",
    notation: "PM2.5",
    pollutant_label: "pm2.5",
    uom: "ug/m3",
  },
  pm10: {
    eionet_uri: "airgradient:pm10",
    label: "PM10",
    notation: "PM10",
    pollutant_label: "pm10",
    uom: "ug/m3",
  },
  co2: {
    eionet_uri: "airgradient:co2",
    label: "CO2",
    notation: "CO2",
    pollutant_label: "co2",
    uom: "ppm",
  },
  temperature: {
    eionet_uri: "airgradient:temperature",
    label: "Temperature",
    notation: "temperature",
    pollutant_label: "temperature",
    uom: "degC",
  },
  humidity: {
    eionet_uri: "airgradient:humidity",
    label: "Humidity",
    notation: "humidity",
    pollutant_label: "humidity",
    uom: "%",
  },
};

const FIELD_ALIASES: Record<string, string[]> = {
  "pm1": ["pm1", "pm_1", "pm01", "pm1_0"],
  "pm2.5": ["pm25", "pm2_5", "pm2.5", "pm_2_5"],
  pm10: ["pm10", "pm_10"],
  co2: ["co2", "co2_ppm"],
  temperature: ["temperature", "temp", "temp_c", "tempC"],
  humidity: ["humidity", "rh", "humidity_percent"],
};

function parseBool(value: string | null | undefined, defaultValue = false): boolean {
  if (value === null || value === undefined) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(normalized);
}

function postgrestHeaders(prefer?: string, schema = UK_AQ_CORE_SCHEMA): Record<string, string> {
  const headers: Record<string, string> = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) {
    headers.Prefer = prefer;
  }
  if (schema && schema !== "public") {
    headers["Accept-Profile"] = schema;
    headers["Content-Profile"] = schema;
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function postgrestIn(values: string[]): string {
  return `in.(${values.map((value) => `"${value.replace(/"/g, "\\\"")}"`).join(",")})`;
}

async function postgrestRequest<T>(
  method: string,
  table: string,
  params?: Record<string, string>,
  body?: unknown,
  prefer?: string,
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
    headers: postgrestHeaders(prefer, schema),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload: unknown = null;
  if (resp.status !== 204) {
    const contentType = resp.headers.get("content-type") ?? "";
    payload = contentType.includes("application/json") ? await resp.json() : await resp.text();
  }
  if (!resp.ok) {
    const message = typeof payload === "string" ? payload : JSON.stringify(payload);
    return { data: null, error: { message } };
  }
  return { data: payload as T, error: null };
}

async function logError(entry: ErrorLogEntry): Promise<void> {
  await postgrestRequest(
    "POST",
    "error_logs",
    undefined,
    {
      source: "ingest_airgradient",
      severity: entry.severity,
      message: entry.message,
      context: entry.context ?? null,
      connector_id: entry.connector_id ?? null,
    },
    "resolution=merge-duplicates,return=minimal",
    UK_AQ_RAW_SCHEMA,
  );
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseObservedAt(entry: Record<string, unknown>): string | null {
  const candidates = [
    entry.timestamp,
    entry.time,
    entry.datetime,
    entry.created_at,
    entry.createdAt,
    entry.measured_at,
    entry.measuredAt,
    entry.updated_at,
    entry.updatedAt,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      const parsed = new Date(candidate);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
    if (typeof candidate === "number") {
      const parsed = new Date(candidate * 1000);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
  }
  return null;
}

function extractMeasurementEntries(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.filter((entry) => entry && typeof entry === "object") as Array<
      Record<string, unknown>
    >;
  }
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["data", "measurements", "items"]) {
      const value = obj[key];
      if (Array.isArray(value)) {
        return value.filter((entry) => entry && typeof entry === "object") as Array<
          Record<string, unknown>
        >;
      }
    }
    return [obj];
  }
  return [];
}

function resolveMeasurementValue(entry: Record<string, unknown>, pollutant: string): number | null {
  const aliases = FIELD_ALIASES[pollutant] ?? [pollutant];
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(entry, alias)) {
      return asNumber(entry[alias]);
    }
  }
  return null;
}

function normalizeLocations(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.filter((item) => item && typeof item === "object") as Array<
      Record<string, unknown>
    >;
  }
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["locations", "data", "items"]) {
      const value = obj[key];
      if (Array.isArray(value)) {
        return value.filter((item) => item && typeof item === "object") as Array<
          Record<string, unknown>
        >;
      }
    }
  }
  return [];
}

function resolveLocationId(location: Record<string, unknown>): string | null {
  const candidate = location.id ?? location.location_id ?? location.locationId;
  if (candidate === null || candidate === undefined) {
    return null;
  }
  return String(candidate);
}

function resolveLocationName(location: Record<string, unknown>): string | null {
  const candidate = location.name ?? location.label ?? location.title;
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }
  return null;
}

function resolveCoordinates(
  location: Record<string, unknown>,
): { longitude: number | null; latitude: number | null } {
  const longitude = asNumber(location.longitude ?? location.lon ?? location.lng);
  const latitude = asNumber(location.latitude ?? location.lat);
  return { longitude, latitude };
}

function buildMeasurementUrl(locationId: string): string {
  const path = AIRGRADIENT_MEASUREMENTS_PATH_TEMPLATE.replace(
    "{location_id}",
    encodeURIComponent(locationId),
  );
  return `${AIRGRADIENT_BASE_URL}/${path.replace(/^\//, "")}`;
}

class AirGradientClient {
  headers: Record<string, string>;

  constructor() {
    this.headers = { "User-Agent": AIRGRADIENT_USER_AGENT };
    if (AIRGRADIENT_API_KEY && AIRGRADIENT_API_KEY_HEADER) {
      this.headers[AIRGRADIENT_API_KEY_HEADER] = AIRGRADIENT_API_KEY;
    }
  }

  async get(path: string, params?: Record<string, string | number | boolean>): Promise<unknown> {
    const url = new URL(`${AIRGRADIENT_BASE_URL}/${path.replace(/^\//, "")}`);
    if (AIRGRADIENT_API_KEY && AIRGRADIENT_API_KEY_PARAM) {
      url.searchParams.set(AIRGRADIENT_API_KEY_PARAM, AIRGRADIENT_API_KEY);
    }
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, String(value));
    }
    const resp = await fetch(url.toString(), { headers: this.headers });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`AirGradient request failed (${resp.status}): ${body}`);
    }
    const contentType = resp.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return await resp.json();
    }
    return await resp.text();
  }

  async listLocations(): Promise<Array<Record<string, unknown>>> {
    const payload = await this.get(AIRGRADIENT_LOCATIONS_PATH);
    return normalizeLocations(payload);
  }

  async listMeasurements(locationId: string): Promise<Array<Record<string, unknown>>> {
    const url = buildMeasurementUrl(locationId);
    const requestUrl = new URL(url);
    if (AIRGRADIENT_API_KEY && AIRGRADIENT_API_KEY_PARAM) {
      requestUrl.searchParams.set(AIRGRADIENT_API_KEY_PARAM, AIRGRADIENT_API_KEY);
    }
    const resp = await fetch(requestUrl.toString(), { headers: this.headers });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`AirGradient measurement failed (${resp.status}): ${body}`);
    }
    const contentType = resp.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json") ? await resp.json() : await resp.text();
    return extractMeasurementEntries(payload);
  }
}

async function upsertConnector(connectorCode: string): Promise<ConnectorRow | null> {
  const connectorLabel = AIRGRADIENT_SERVICE_LABEL;
  const serviceUrl = AIRGRADIENT_BASE_URL;
  const select = [
    "id",
    "connector_code",
    "label",
    "service_url",
    "overwrite_station_name",
  ].join(",");

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
        overwrite_station_name: false,
        poll_enabled: false,
        poll_interval_minutes: 15,
        poll_window_hours: DEFAULT_WINDOW_HOURS,
        stations_bbox_supported: false,
        timeseries_station_filter_supported: false,
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

async function upsertPhenomena(connectorId: string): Promise<Record<string, number>> {
  const payload = Object.values(AIRGRADIENT_PHENOMENA).map((meta) => ({
    connector_id: connectorId,
    eionet_uri: meta.eionet_uri,
    label: meta.label,
    notation: meta.notation,
    pollutant_label: meta.pollutant_label,
  }));
  await postgrestRequest(
    "POST",
    "phenomena",
    { on_conflict: "connector_id,eionet_uri" },
    payload,
    "resolution=merge-duplicates,return=minimal",
  );
  const { data } = await postgrestRequest<Array<{ id: number; eionet_uri: string }>>(
    "GET",
    "phenomena",
    {
      select: "id,eionet_uri",
      connector_id: `eq.${connectorId}`,
      eionet_uri: postgrestIn(Object.values(AIRGRADIENT_PHENOMENA).map((meta) => meta.eionet_uri)),
    },
  );
  const idsByUri: Record<string, number> = {};
  for (const row of data ?? []) {
    if (row?.eionet_uri) {
      idsByUri[row.eionet_uri] = Number(row.id);
    }
  }
  const idsByPollutant: Record<string, number> = {};
  for (const [pollutant, meta] of Object.entries(AIRGRADIENT_PHENOMENA)) {
    const phenId = idsByUri[meta.eionet_uri];
    if (phenId) {
      idsByPollutant[pollutant] = phenId;
    }
  }
  return idsByPollutant;
}

async function fetchStationNames(
  connectorId: string,
  serviceRef: string,
  stationRefs: string[],
): Promise<Record<string, string | null>> {
  const mapping: Record<string, string | null> = {};
  for (let idx = 0; idx < stationRefs.length; idx += 200) {
    const chunk = stationRefs.slice(idx, idx + 200);
    const { data } = await postgrestRequest<Array<{ station_ref: string; station_name: string | null }>>(
      "GET",
      "stations",
      {
        select: "station_ref,station_name",
        connector_id: `eq.${connectorId}`,
        service_ref: `eq.${serviceRef}`,
        station_ref: postgrestIn(chunk),
      },
    );
    for (const row of data ?? []) {
      mapping[String(row.station_ref)] = row.station_name ?? null;
    }
  }
  return mapping;
}

async function fetchStationIds(
  connectorId: string,
  serviceRef: string,
  stationRefs: string[],
): Promise<Record<string, number>> {
  const mapping: Record<string, number> = {};
  for (let idx = 0; idx < stationRefs.length; idx += 200) {
    const chunk = stationRefs.slice(idx, idx + 200);
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

async function upsertStations(
  locations: Array<Record<string, unknown>>,
  connectorId: string,
  serviceRef: string,
  overwriteStationName: boolean,
): Promise<number> {
  const rowsByRef: Record<string, Record<string, unknown>> = {};
  for (const location of locations) {
    const stationRef = resolveLocationId(location);
    if (!stationRef) {
      continue;
    }
    const { longitude, latitude } = resolveCoordinates(location);
    const stationName = resolveLocationName(location);
    const row: Record<string, unknown> = {
      station_ref: stationRef,
      service_ref: String(serviceRef),
      label: stationName ?? `AirGradient ${stationRef}`,
      station_name: stationName,
      station_type: location.locationType ?? location.type ?? null,
      region: location.city ?? location.region ?? null,
      geometry: longitude !== null && latitude !== null
        ? `SRID=4326;POINT(${longitude} ${latitude})`
        : null,
      connector_id: connectorId,
      last_seen_at: new Date().toISOString(),
      removed_at: null,
    };
    rowsByRef[stationRef] = rowsByRef[stationRef]
      ? { ...rowsByRef[stationRef], ...row }
      : row;
  }
  const rows = Object.values(rowsByRef);
  if (!rows.length) {
    return 0;
  }
  if (!overwriteStationName) {
    const existingNames = await fetchStationNames(
      connectorId,
      serviceRef,
      rows.map((row) => String(row.station_ref ?? "")).filter((ref) => ref),
    );
    for (const row of rows) {
      const stationRef = String(row.station_ref ?? "");
      if (!stationRef) {
        continue;
      }
      const existingName = existingNames[stationRef];
      if (existingName && typeof existingName === "string" && existingName.trim()) {
        if ("station_name" in row) {
          delete row.station_name;
        }
      }
    }
  }
  await postgrestRequest(
    "POST",
    "stations",
    { on_conflict: "connector_id,service_ref,station_ref" },
    rows,
    "resolution=merge-duplicates,return=minimal",
  );
  return rows.length;
}

async function upsertTimeseries(rows: Array<Record<string, unknown>>): Promise<number> {
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
  const mapping: Record<string, number> = {};
  for (let idx = 0; idx < timeseriesRefs.length; idx += 200) {
    const chunk = timeseriesRefs.slice(idx, idx + 200);
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

async function upsertObservations(rows: Array<Record<string, unknown>>): Promise<number> {
  if (!rows.length) {
    return 0;
  }
  await postgrestRequest(
    "POST",
    "observations",
    undefined,
    rows,
    "resolution=merge-duplicates,return=minimal",
  );
  return rows.length;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  const authResponse = requireCronSecret(req);
  if (authResponse) {
    return authResponse;
  }
  if (!AIRGRADIENT_API_KEY) {
    return jsonResponse({ error: "AIRGRADIENT_API_KEY is required." }, 500);
  }

  let payload: PollRequest = {};
  if (req.method === "POST") {
    try {
      payload = await req.json();
    } catch (_err) {
      payload = {};
    }
  }

  const connectorCode = payload.connector_code ?? AIRGRADIENT_CONNECTOR_CODE;
  const stationRefs = Array.isArray(payload.station_refs)
    ? payload.station_refs.map((ref) => String(ref))
    : [];
  const windowHours = Number(payload.window_hours ?? DEFAULT_WINDOW_HOURS);
  const dryRun = payload.dry_run ?? false;

  const connector = await upsertConnector(connectorCode);
  if (!connector) {
    return jsonResponse({ error: "Failed to resolve connector metadata." }, 500);
  }

  const connectorId = String(connector.id);
  const overwriteStationName = connector.overwrite_station_name ?? false;
  const client = new AirGradientClient();

  let locations: Array<Record<string, unknown>>;
  try {
    locations = await client.listLocations();
  } catch (err) {
    await logError({
      severity: "error",
      message: "AirGradient location fetch failed",
      connector_id: connector.id,
      context: { error: String(err) },
    });
    return jsonResponse({ error: String(err) }, 502);
  }

  if (stationRefs.length) {
    locations = locations.filter((loc) => {
      const locationId = resolveLocationId(loc);
      return locationId ? stationRefs.includes(locationId) : false;
    });
  }

  const stationsUpdated = dryRun
    ? locations.length
    : await upsertStations(locations, connectorId, AIRGRADIENT_SERVICE_REF, overwriteStationName);
  const stationIdByRef = await fetchStationIds(
    connectorId,
    AIRGRADIENT_SERVICE_REF,
    locations
      .map((location) => resolveLocationId(location))
      .filter((id): id is string => Boolean(id)),
  );
  const phenomenonIds = await upsertPhenomena(connectorId);

  const timeseriesByRef = new Map<string, Record<string, unknown>>();
  const observationRows: Array<Record<string, unknown>> = [];
  let seriesPolled = 0;
  let latestObservedAt: string | null = null;

  for (const location of locations) {
    const locationId = resolveLocationId(location);
    if (!locationId) {
      continue;
    }
    let measurements: Array<Record<string, unknown>> = [];
    try {
      measurements = await client.listMeasurements(locationId);
    } catch (err) {
      await logError({
        severity: "warn",
        message: "AirGradient measurement fetch failed",
        connector_id: connector.id,
        context: { location_id: locationId, error: String(err) },
      });
      continue;
    }
    if (!measurements.length) {
      continue;
    }
    const stationId = stationIdByRef[locationId];
    if (!stationId) {
      continue;
    }

    for (const entry of measurements) {
      const observedAt = parseObservedAt(entry);
      if (!observedAt) {
        continue;
      }
      if (!latestObservedAt || observedAt > latestObservedAt) {
        latestObservedAt = observedAt;
      }
      for (const pollutant of Object.keys(AIRGRADIENT_PHENOMENA)) {
        const value = resolveMeasurementValue(entry, pollutant);
        if (value === null) {
          continue;
        }
        const phenomenonId = phenomenonIds[pollutant];
        if (!phenomenonId) {
          continue;
        }
        const timeseriesRef = `${locationId}:${pollutant}`;
        const existing = timeseriesByRef.get(timeseriesRef);
        if (!existing || (existing.last_value_at && observedAt > existing.last_value_at)) {
          timeseriesByRef.set(timeseriesRef, {
            timeseries_ref: timeseriesRef,
            label: AIRGRADIENT_PHENOMENA[pollutant].label,
            uom: AIRGRADIENT_PHENOMENA[pollutant].uom,
            station_id: stationId,
            service_ref: AIRGRADIENT_SERVICE_REF,
            connector_id: connectorId,
            phenomenon_id: phenomenonId,
            last_value_at: observedAt,
            last_value: value,
          });
        }
        observationRows.push({
          connector_id: connectorId,
          timeseries_ref: timeseriesRef,
          observed_at: observedAt,
          value,
        });
      }
    }
  }

  const timeseriesRows = Array.from(timeseriesByRef.values());
  const uniqueTimeseriesRefs = Array.from(timeseriesByRef.keys()).filter((ref) => ref);

  if (!dryRun) {
    await upsertTimeseries(timeseriesRows);
    const timeseriesIdByRef = await fetchTimeseriesIds(
      connectorId,
      AIRGRADIENT_SERVICE_REF,
      uniqueTimeseriesRefs,
    );
    for (const row of observationRows) {
      const ref = String(row.timeseries_ref ?? "");
      row.timeseries_id = timeseriesIdByRef[ref];
      delete row.timeseries_ref;
    }
    const filteredObservations = observationRows.filter((row) => row.timeseries_id);
    if (filteredObservations.length) {
      await upsertObservations(filteredObservations);
      seriesPolled = uniqueTimeseriesRefs.length;
    }
  }

  return jsonResponse({
    connector_code: connectorCode,
    stations_updated: stationsUpdated,
    timeseries_updated: uniqueTimeseriesRefs.length,
    observations_upserted: dryRun ? 0 : observationRows.length,
    series_polled: seriesPolled,
    window_hours: windowHours,
    last_observed_at: latestObservedAt,
    dry_run: dryRun,
  });
});
