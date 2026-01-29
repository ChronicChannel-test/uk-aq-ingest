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

type OpenAQLocation = {
  id?: number;
  name?: string | null;
  locality?: string | null;
  isMobile?: boolean | null;
  isMonitor?: boolean | null;
  coordinates?: { latitude?: number | null; longitude?: number | null } | null;
  country?: { code?: string | null; name?: string | null } | null;
  sensors?: Array<{
    id?: number;
    name?: string | null;
    parameter?: { name?: string | null; units?: string | null; displayName?: string | null } | null;
  }>;
};

type OpenAQLatestRecord = {
  datetime?: { utc?: string | null } | null;
  value?: number | null;
  sensorsId?: number | null;
  locationsId?: number | null;
  coordinates?: { latitude?: number | null; longitude?: number | null } | null;
};

const DEFAULT_BASE_URL = "https://api.openaq.org/v3";
const DEFAULT_CONNECTOR_CODE = "openaq";
const DEFAULT_SERVICE_LABEL = "OpenAQ";
const DEFAULT_USER_AGENT = "uk-air-quality-networks";
const DEFAULT_WINDOW_HOURS = 6;
const DEFAULT_BBOX = "-8.623555,49.863222,1.763337,60.871222";
const DEFAULT_PAGE_LIMIT = 1000;
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_CONCURRENCY = 6;

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

const OPENAQ_BASE_URL = (Deno.env.get("OPENAQ_BASE_URL") ?? DEFAULT_BASE_URL)
  .replace(/\/$/, "");
const OPENAQ_CONNECTOR_CODE = Deno.env.get("OPENAQ_CONNECTOR_CODE") ?? DEFAULT_CONNECTOR_CODE;
const OPENAQ_SERVICE_REF = Deno.env.get("OPENAQ_SERVICE_REF") ?? OPENAQ_CONNECTOR_CODE;
const OPENAQ_SERVICE_LABEL = Deno.env.get("OPENAQ_SERVICE_LABEL") ?? DEFAULT_SERVICE_LABEL;
const OPENAQ_USER_AGENT = Deno.env.get("OPENAQ_USER_AGENT") ?? DEFAULT_USER_AGENT;
const OPENAQ_API_KEY = (Deno.env.get("OPENAQ_API_KEY") ?? "").trim();
const OPENAQ_BBOX = Deno.env.get("OPENAQ_BBOX") ?? DEFAULT_BBOX;
const OPENAQ_PAGE_LIMIT = Number(Deno.env.get("OPENAQ_PAGE_LIMIT") ?? DEFAULT_PAGE_LIMIT);
const OPENAQ_MAX_PAGES = Number(Deno.env.get("OPENAQ_MAX_PAGES") ?? DEFAULT_MAX_PAGES);
const OPENAQ_CONCURRENCY = Number(Deno.env.get("OPENAQ_CONCURRENCY") ?? DEFAULT_CONCURRENCY);

const REST_BASE_URL = SUPABASE_URL
  ? `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1`
  : "";

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

function openaqHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": OPENAQ_USER_AGENT,
    "Accept": "application/json",
  };
  if (OPENAQ_API_KEY) {
    headers["X-API-Key"] = OPENAQ_API_KEY;
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
  return `in.(${values.map((value) => `"${value.replace(/\"/g, "\\\"")}"`).join(",")})`;
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
      source: "ingest_openaq",
      severity: entry.severity,
      message: entry.message,
      context: entry.context ?? null,
      connector_id: entry.connector_id ?? null,
    },
    "resolution=merge-duplicates,return=minimal",
    UK_AQ_RAW_SCHEMA,
  );
}

function parseBbox(value: string): string {
  const parts = value.split(",").map((part) => part.trim()).filter((part) => part);
  if (parts.length !== 4) {
    throw new Error("OPENAQ_BBOX must have 4 comma-delimited values.");
  }
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((num) => !Number.isFinite(num))) {
    throw new Error("OPENAQ_BBOX contains invalid numbers.");
  }
  return numbers.join(",");
}

async function openaqRequest(path: string, params?: Record<string, string | number>): Promise<any> {
  const url = new URL(`${OPENAQ_BASE_URL}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const resp = await fetch(url.toString(), { headers: openaqHeaders() });
  const contentType = resp.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await resp.json() : await resp.text();
  if (!resp.ok) {
    const message = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(`OpenAQ request failed (${resp.status}): ${message}`);
  }
  return payload;
}

async function listLocations(bbox: string): Promise<OpenAQLocation[]> {
  const results: OpenAQLocation[] = [];
  const limit = Number.isFinite(OPENAQ_PAGE_LIMIT) && OPENAQ_PAGE_LIMIT > 0
    ? Math.min(OPENAQ_PAGE_LIMIT, 1000)
    : DEFAULT_PAGE_LIMIT;
  let page = 1;
  while (true) {
    const payload = await openaqRequest("locations", { bbox, limit, page });
    const pageResults = Array.isArray(payload?.results) ? payload.results as OpenAQLocation[] : [];
    results.push(...pageResults);
    if (!pageResults.length) {
      break;
    }
    if (pageResults.length < limit) {
      break;
    }
    page += 1;
    if (Number.isFinite(OPENAQ_MAX_PAGES) && OPENAQ_MAX_PAGES > 0 && page > OPENAQ_MAX_PAGES) {
      break;
    }
  }
  return results;
}

async function listLatestForLocation(locationId: string): Promise<OpenAQLatestRecord[]> {
  const payload = await openaqRequest(`locations/${locationId}/latest`, { limit: 1000 });
  return Array.isArray(payload?.results) ? payload.results as OpenAQLatestRecord[] : [];
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const pool = new Set<Promise<void>>();
  const limit = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 1;
  for (const item of items) {
    const task = worker(item);
    pool.add(task);
    task.finally(() => pool.delete(task));
    if (pool.size >= limit) {
      await Promise.race(pool);
    }
  }
  await Promise.all(pool);
}

function resolveLocationId(location: OpenAQLocation): string | null {
  if (location?.id === null || location?.id === undefined) {
    return null;
  }
  return String(location.id);
}

function resolveLocationName(location: OpenAQLocation): string | null {
  if (location?.name && String(location.name).trim()) {
    return String(location.name).trim();
  }
  if (location?.locality && String(location.locality).trim()) {
    return String(location.locality).trim();
  }
  return null;
}

function resolveCoordinates(location: OpenAQLocation): { longitude: number | null; latitude: number | null } {
  const longitude = location?.coordinates?.longitude;
  const latitude = location?.coordinates?.latitude;
  return {
    longitude: Number.isFinite(longitude) ? Number(longitude) : null,
    latitude: Number.isFinite(latitude) ? Number(latitude) : null,
  };
}

async function loadConnector(connectorCode: string): Promise<ConnectorRow | null> {
  const select = [
    "id",
    "connector_code",
    "label",
    "service_url",
    "overwrite_station_name",
  ].join(",");
  const { data, error } = await postgrestRequest<ConnectorRow[]>("GET", "connectors", {
    select,
    connector_code: `eq.${connectorCode}`,
    limit: "1",
  });
  if (error) {
    throw new Error(`Connector fetch failed: ${error.message}`);
  }
  return data && data[0] ? data[0] : null;
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
  locations: OpenAQLocation[],
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
      label: stationName ?? `OpenAQ ${stationRef}`,
      station_name: stationName,
      station_type: location?.isMobile ? "mobile" : "fixed",
      region: location?.locality ?? location?.country?.name ?? null,
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

type ParameterMeta = { name: string; displayName: string | null; units: string | null };

async function upsertPhenomena(
  connectorId: string,
  parameters: Record<string, ParameterMeta>,
): Promise<Record<string, number>> {
  const payload = Object.values(parameters).map((meta) => ({
    connector_id: connectorId,
    eionet_uri: `openaq:${meta.name}`,
    label: meta.displayName ?? meta.name,
    notation: meta.displayName ?? meta.name,
    pollutant_label: meta.name,
  }));
  if (payload.length) {
    await postgrestRequest(
      "POST",
      "phenomena",
      { on_conflict: "connector_id,eionet_uri" },
      payload,
      "resolution=merge-duplicates,return=minimal",
    );
  }
  const eionetUris = Object.values(parameters).map((meta) => `openaq:${meta.name}`);
  if (!eionetUris.length) {
    return {};
  }
  const { data } = await postgrestRequest<Array<{ id: number; eionet_uri: string }>>(
    "GET",
    "phenomena",
    {
      select: "id,eionet_uri",
      connector_id: `eq.${connectorId}`,
      eionet_uri: postgrestIn(eionetUris),
    },
  );
  const idsByUri: Record<string, number> = {};
  for (const row of data ?? []) {
    if (row?.eionet_uri) {
      idsByUri[row.eionet_uri] = Number(row.id);
    }
  }
  const idsByName: Record<string, number> = {};
  for (const meta of Object.values(parameters)) {
    const phenId = idsByUri[`openaq:${meta.name}`];
    if (phenId) {
      idsByName[meta.name] = phenId;
    }
  }
  return idsByName;
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
    { on_conflict: "connector_id,timeseries_id,observed_at" },
    rows,
    "resolution=merge-duplicates,return=minimal",
  );
  return rows.length;
}

function collectParameters(locations: OpenAQLocation[]): Record<string, ParameterMeta> {
  const parameters: Record<string, ParameterMeta> = {};
  for (const location of locations) {
    for (const sensor of location?.sensors ?? []) {
      const paramName = sensor?.parameter?.name;
      if (!paramName || !String(paramName).trim()) {
        continue;
      }
      const name = String(paramName).trim();
      if (!parameters[name]) {
        parameters[name] = {
          name,
          displayName: sensor?.parameter?.displayName
            ? String(sensor.parameter.displayName)
            : null,
          units: sensor?.parameter?.units
            ? String(sensor.parameter.units)
            : null,
        };
      }
    }
  }
  return parameters;
}

function collectSensors(locations: OpenAQLocation[]): Map<string, { locationId: string; parameter: ParameterMeta }> {
  const sensors = new Map<string, { locationId: string; parameter: ParameterMeta }>();
  for (const location of locations) {
    const locationId = resolveLocationId(location);
    if (!locationId) {
      continue;
    }
    for (const sensor of location?.sensors ?? []) {
      const sensorId = sensor?.id;
      const paramName = sensor?.parameter?.name;
      if (!sensorId || !paramName) {
        continue;
      }
      const name = String(paramName).trim();
      if (!name) {
        continue;
      }
      const parameter: ParameterMeta = {
        name,
        displayName: sensor?.parameter?.displayName
          ? String(sensor.parameter.displayName)
          : null,
        units: sensor?.parameter?.units
          ? String(sensor.parameter.units)
          : null,
      };
      sensors.set(String(sensorId), { locationId, parameter });
    }
  }
  return sensors;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  const authResponse = requireCronSecret(req);
  if (authResponse) {
    return authResponse;
  }
  if (!OPENAQ_API_KEY) {
    return jsonResponse({ error: "OPENAQ_API_KEY is required." }, 500);
  }

  let payload: PollRequest = {};
  if (req.method === "POST") {
    try {
      payload = await req.json();
    } catch (_err) {
      payload = {};
    }
  }

  const connectorCode = payload.connector_code ?? OPENAQ_CONNECTOR_CODE;
  const stationRefs = Array.isArray(payload.station_refs)
    ? payload.station_refs.map((ref) => String(ref))
    : [];
  const windowHours = Number(payload.window_hours ?? DEFAULT_WINDOW_HOURS);
  const dryRun = payload.dry_run ?? false;

  const connector = await loadConnector(connectorCode);
  if (!connector) {
    return jsonResponse({ error: "Connector not found." }, 404);
  }

  let bbox: string;
  try {
    bbox = parseBbox(OPENAQ_BBOX);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }

  let locations: OpenAQLocation[] = [];
  try {
    locations = await listLocations(bbox);
  } catch (err) {
    await logError({
      severity: "error",
      message: "OpenAQ location fetch failed",
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

  const connectorId = String(connector.id);
  const overwriteStationName = connector.overwrite_station_name ?? false;
  const stationsUpdated = dryRun
    ? locations.length
    : await upsertStations(locations, connectorId, OPENAQ_SERVICE_REF, overwriteStationName);

  const stationIdByRef = await fetchStationIds(
    connectorId,
    OPENAQ_SERVICE_REF,
    locations
      .map((location) => resolveLocationId(location))
      .filter((id): id is string => Boolean(id)),
  );

  const parameters = collectParameters(locations);
  const sensorMap = collectSensors(locations);
  const phenomenonIds = await upsertPhenomena(connectorId, parameters);

  const latestBySensor = new Map<string, { observed_at: string; value: number | null }>();
  const nowMs = Date.now();
  const windowMs = Number.isFinite(windowHours) && windowHours > 0
    ? windowHours * 60 * 60 * 1000
    : null;

  const locationIds = locations
    .map((location) => resolveLocationId(location))
    .filter((id): id is string => Boolean(id));

  await runPool(locationIds, OPENAQ_CONCURRENCY, async (locationId) => {
    let latest: OpenAQLatestRecord[] = [];
    try {
      latest = await listLatestForLocation(locationId);
    } catch (err) {
      await logError({
        severity: "warn",
        message: "OpenAQ latest fetch failed",
        connector_id: connector.id,
        context: { location_id: locationId, error: String(err) },
      });
      return;
    }
    for (const record of latest) {
      const sensorId = record?.sensorsId;
      const observedAt = record?.datetime?.utc;
      if (!sensorId || !observedAt) {
        continue;
      }
      const observedMs = Date.parse(observedAt);
      if (!Number.isFinite(observedMs)) {
        continue;
      }
      if (windowMs && observedMs < nowMs - windowMs) {
        continue;
      }
      const value = record?.value;
      const key = String(sensorId);
      const existing = latestBySensor.get(key);
      if (!existing || observedAt > existing.observed_at) {
        latestBySensor.set(key, { observed_at: observedAt, value: value ?? null });
      }
    }
  });

  const timeseriesRows: Array<Record<string, unknown>> = [];
  const timeseriesRefs: string[] = [];
  for (const [sensorId, meta] of sensorMap.entries()) {
    const stationId = stationIdByRef[meta.locationId];
    if (!stationId) {
      continue;
    }
    const phenomenonId = phenomenonIds[meta.parameter.name];
    if (!phenomenonId) {
      continue;
    }
    const latest = latestBySensor.get(sensorId);
    const label = `${meta.locationId} ${meta.parameter.displayName ?? meta.parameter.name}`;
    timeseriesRows.push({
      timeseries_ref: sensorId,
      label,
      uom: meta.parameter.units ?? null,
      station_id: stationId,
      connector_id: connectorId,
      service_ref: OPENAQ_SERVICE_REF,
      phenomenon_id: phenomenonId,
      last_value_at: latest?.observed_at ?? null,
      last_value: latest?.value ?? null,
    });
    timeseriesRefs.push(sensorId);
  }

  let observationsUpserted = 0;
  let seriesPolled = 0;
  let lastObservedAt: string | null = null;

  if (!dryRun) {
    await upsertTimeseries(timeseriesRows);
    const timeseriesIdByRef = await fetchTimeseriesIds(
      connectorId,
      OPENAQ_SERVICE_REF,
      timeseriesRefs,
    );

    const observationRows: Array<Record<string, unknown>> = [];
    for (const [sensorId, latest] of latestBySensor.entries()) {
      const timeseriesId = timeseriesIdByRef[sensorId];
      if (!timeseriesId) {
        continue;
      }
      observationRows.push({
        connector_id: connectorId,
        timeseries_id: timeseriesId,
        observed_at: latest.observed_at,
        value: latest.value,
        status: null,
      });
      seriesPolled += 1;
      if (!lastObservedAt || latest.observed_at > lastObservedAt) {
        lastObservedAt = latest.observed_at;
      }
    }

    observationsUpserted = await upsertObservations(observationRows);
  }

  return jsonResponse({
    connector_code: connectorCode,
    stations_updated: stationsUpdated,
    timeseries_updated: timeseriesRows.length,
    observations_upserted: observationsUpserted,
    series_polled: seriesPolled,
    window_hours: windowHours,
    last_observed_at: lastObservedAt,
    dry_run: dryRun,
  });
});
