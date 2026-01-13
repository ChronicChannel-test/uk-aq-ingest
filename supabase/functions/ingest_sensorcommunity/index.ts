// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type PollRequest = {
  connector_id?: string;
  connector_code?: string;
  connector_label?: string;
  service_ref?: string;
  country?: string;
  base_url?: string;
  no_filter?: boolean;
};

type ConnectorRow = {
  id: string;
  connector_code: string;
  label: string;
  service_url: string | null;
};

const DEFAULT_BASE_URL = "https://data.sensor.community";
const DEFAULT_CONNECTOR_CODE = "sensorcommunity";
const DEFAULT_SERVICE_LABEL = "Sensor.Community";
const DEFAULT_COUNTRY = "GB";
const DEFAULT_USER_AGENT = "uk-air-quality-networks";
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const UK_BBOX = {
  west: -11.0,
  south: 49.0,
  east: 2.0,
  north: 61.0,
};

const VALUE_TYPE_MAP: Record<string, { pollutant: string; label: string; uom: string }> = {
  P1: { pollutant: "pm10", label: "PM10", uom: "ug/m3" },
  P2: { pollutant: "pm2.5", label: "PM2.5", uom: "ug/m3" },
};

const SCOMM_PHENOMENA: Record<string, { eionet_uri: string; label: string; notation: string; pollutant_label: string }> = {
  pm10: {
    eionet_uri: "sensorcommunity:pm10",
    label: "PM10",
    notation: "PM10",
    pollutant_label: "pm10",
  },
  "pm2.5": {
    eionet_uri: "sensorcommunity:pm2.5",
    label: "PM2.5",
    notation: "PM2.5",
    pollutant_label: "pm2.5",
  },
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")
  ?? Deno.env.get("SB_SUPABASE_URL")
  ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  ?? Deno.env.get("SB_SERVICE_ROLE_KEY")
  ?? "";

const SCOMM_BASE_URL = (Deno.env.get("SCOMM_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/$/, "");
const SCOMM_CONNECTOR_CODE = Deno.env.get("SCOMM_CONNECTOR_CODE")
  ?? Deno.env.get("SCOMM_CONNECTOR_REF")
  ?? Deno.env.get("SCOMM_SERVICE_REF")
  ?? DEFAULT_CONNECTOR_CODE;
const SCOMM_SERVICE_REF = Deno.env.get("SCOMM_SERVICE_REF") ?? SCOMM_CONNECTOR_CODE;
const SCOMM_SERVICE_LABEL = Deno.env.get("SCOMM_SERVICE_LABEL")
  ?? Deno.env.get("SCOMM_CONNECTOR_LABEL")
  ?? DEFAULT_SERVICE_LABEL;
const SCOMM_COUNTRY = Deno.env.get("SCOMM_COUNTRY") ?? DEFAULT_COUNTRY;
const SCOMM_USER_AGENT = Deno.env.get("SCOMM_USER_AGENT") ?? DEFAULT_USER_AGENT;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url: string, attempts = 3): Promise<unknown> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": SCOMM_USER_AGENT,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      if (RETRYABLE_STATUS.has(resp.status)) {
        throw new Error(`Sensor.Community retryable status: ${resp.status}`);
      }
      if (!resp.ok) {
        throw new Error(`Sensor.Community error: ${resp.status}`);
      }
      return await resp.json();
    } catch (err) {
      if (attempt >= attempts) {
        throw err;
      }
      await sleep(Math.min(30_000, 2 ** attempt * 1000));
    } finally {
      clearTimeout(timeout);
    }
  }
  return [];
}

function coerceNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const num = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(num) ? num : null;
}

function maybeSwapCoords(
  lon: number | null,
  lat: number | null,
  bbox: { west: number; south: number; east: number; north: number } | null,
): [number | null, number | null] {
  if (lon === null || lat === null || !bbox) {
    return [lon, lat];
  }
  const lonLooksLat = bbox.south <= lon && lon <= bbox.north;
  const latLooksLon = bbox.west <= lat && lat <= bbox.east;
  const lonIsLon = bbox.west <= lon && lon <= bbox.east;
  const latIsLat = bbox.south <= lat && lat <= bbox.north;
  if (lonLooksLat && latLooksLon && !lonIsLon && !latIsLat) {
    return [lat, lon];
  }
  return [lon, lat];
}

function stationCoords(
  station: Record<string, unknown>,
  bbox: { west: number; south: number; east: number; north: number } | null = null,
): [number | null, number | null] {
  let coords: unknown = null;
  if (station.geometry && typeof station.geometry === "object") {
    coords = (station.geometry as Record<string, unknown>).coordinates;
  }
  if (!coords && station.properties && typeof station.properties === "object") {
    const geometry = (station.properties as Record<string, unknown>).geometry;
    if (geometry && typeof geometry === "object") {
      coords = (geometry as Record<string, unknown>).coordinates;
    }
  }
  if (Array.isArray(coords) && coords.length >= 2) {
    const lon = coerceNumber(coords[0]);
    const lat = coerceNumber(coords[1]);
    return maybeSwapCoords(lon, lat, bbox);
  }
  const props = (station.properties && typeof station.properties === "object")
    ? station.properties as Record<string, unknown>
    : {};
  const lon = coerceNumber(props.longitude ?? props.lon ?? props.lng);
  const lat = coerceNumber(props.latitude ?? props.lat);
  return maybeSwapCoords(lon, lat, bbox);
}

function stationInBboxOrMissingCoords(
  station: Record<string, unknown>,
  bbox: { west: number; south: number; east: number; north: number },
): boolean {
  const [lon, lat] = stationCoords(station, bbox);
  if (lon === null || lat === null) {
    return true;
  }
  if (!(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90)) {
    return false;
  }
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

function stationStub(record: Record<string, unknown>): Record<string, unknown> {
  const location = (record.location && typeof record.location === "object")
    ? record.location as Record<string, unknown>
    : {};
  return {
    properties: {
      longitude: location.longitude,
      latitude: location.latitude,
    },
  };
}

function normalizeStationPayload(record: Record<string, unknown>): {
  station_ref: string | null;
  label: string | null;
  station_name: string | null;
  station_type: string | null;
  longitude: number | null;
  latitude: number | null;
} {
  const location = (record.location && typeof record.location === "object")
    ? record.location as Record<string, unknown>
    : {};
  const sensor = (record.sensor && typeof record.sensor === "object")
    ? record.sensor as Record<string, unknown>
    : {};
  const sensorType = (record.sensor_type && typeof record.sensor_type === "object")
    ? record.sensor_type as Record<string, unknown>
    : {};
  const lon = coerceNumber(location.longitude);
  const lat = coerceNumber(location.latitude);
  const [lonVal, latVal] = maybeSwapCoords(lon, lat, UK_BBOX);
  const stationRef = sensor.id ?? record.sensor_id ?? record.id;
  const label = (location.name ?? record.location_name) as string | null ?? null;
  const stationType = (sensorType.name ?? sensorType.id) as string | null ?? null;
  return {
    station_ref: stationRef !== undefined && stationRef !== null ? String(stationRef) : null,
    label,
    station_name: label,
    station_type: stationType !== undefined && stationType !== null ? String(stationType) : null,
    longitude: lonVal,
    latitude: latVal,
  };
}

function mergeStationRow(
  existing: Record<string, unknown>,
  candidate: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(candidate)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  let candidate = trimmed;
  if (!candidate.endsWith("Z") && !candidate.includes("+") && !candidate.includes("T")) {
    candidate = candidate.replace(" ", "T") + "Z";
  } else if (!candidate.endsWith("Z") && candidate.includes("T") && !candidate.includes("+")) {
    candidate = candidate + "Z";
  }
  const ms = Date.parse(candidate);
  if (Number.isNaN(ms)) {
    return null;
  }
  return new Date(ms).toISOString();
}

function quotePostgrestValue(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function postgrestIn(values: string[]): string {
  return `in.(${values.map(quotePostgrestValue).join(",")})`;
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
        service_url: serviceUrl,
        poll_enabled: true,
        poll_interval_minutes: 15,
        poll_window_hours: 1,
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
  const payload = Object.values(SCOMM_PHENOMENA).map((meta) => ({
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
      eionet_uri: postgrestIn(Object.values(SCOMM_PHENOMENA).map((meta) => meta.eionet_uri)),
    },
  );
  const idsByUri: Record<string, number> = {};
  for (const row of data ?? []) {
    if (row?.eionet_uri) {
      idsByUri[row.eionet_uri] = Number(row.id);
    }
  }
  const idsByPollutant: Record<string, number> = {};
  for (const [pollutant, meta] of Object.entries(SCOMM_PHENOMENA)) {
    const phenId = idsByUri[meta.eionet_uri];
    if (phenId) {
      idsByPollutant[pollutant] = phenId;
    }
  }
  return idsByPollutant;
}

async function upsertStations(
  stations: Array<Record<string, unknown>>,
  connectorId: string,
  serviceRef: string,
): Promise<number> {
  const rowsByRef: Record<string, Record<string, unknown>> = {};
  for (const station of stations) {
    const payload = normalizeStationPayload(station);
    if (!payload.station_ref) {
      continue;
    }
    const stationRef = payload.station_ref;
    const row: Record<string, unknown> = {
      station_ref: stationRef,
      service_ref: String(serviceRef),
      label: payload.label ?? `Sensor.Community ${stationRef}`,
      station_name: payload.station_name,
      station_type: payload.station_type,
      geometry: payload.longitude !== null && payload.latitude !== null
        ? `SRID=4326;POINT(${payload.longitude} ${payload.latitude})`
        : null,
      connector_id: connectorId,
      last_seen_at: new Date().toISOString(),
      removed_at: null,
    };
    const existing = rowsByRef[stationRef];
    rowsByRef[stationRef] = existing ? mergeStationRow(existing, row) : row;
  }
  const rows = Object.values(rowsByRef);
  if (!rows.length) {
    return 0;
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

async function upsertTimeseries(
  rows: Array<Record<string, unknown>>,
): Promise<number> {
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

async function backfillTimeseriesPhenomena(
  connectorId: string,
  serviceRef: string,
  phenomenonIds: Record<string, number>,
): Promise<number> {
  let updated = 0;
  let offset = 0;
  const limit = 1000;
  while (true) {
    const { data } = await postgrestRequest<Array<{ id: number; timeseries_ref: string | null }>>(
      "GET",
      "timeseries",
      {
        select: "id,timeseries_ref",
        connector_id: `eq.${connectorId}`,
        service_ref: `eq.${serviceRef}`,
        phenomenon_id: "is.null",
        limit: String(limit),
        offset: String(offset),
      },
    );
    if (!data || data.length === 0) {
      break;
    }
    const idsByPollutant: Record<string, number[]> = { pm10: [], "pm2.5": [] };
    for (const row of data) {
      const ref = String(row.timeseries_ref ?? "").toLowerCase();
      let pollutant: string | null = null;
      if (ref.endsWith(":pm10")) {
        pollutant = "pm10";
      } else if (ref.endsWith(":pm2.5")) {
        pollutant = "pm2.5";
      }
      if (pollutant && row.id !== null && row.id !== undefined) {
        idsByPollutant[pollutant].push(Number(row.id));
      }
    }
    for (const [pollutant, ids] of Object.entries(idsByPollutant)) {
      const phenId = phenomenonIds[pollutant];
      if (!phenId || !ids.length) {
        continue;
      }
      await postgrestRequest(
        "PATCH",
        "timeseries",
        { id: postgrestIn(ids.map(String)) },
        { phenomenon_id: phenId },
        "return=minimal",
      );
      updated += ids.length;
    }
    if (data.length < limit) {
      break;
    }
    offset += limit;
  }
  return updated;
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
    { on_conflict: "timeseries_id,observed_at" },
    rows,
    "resolution=merge-duplicates,return=minimal",
  );
  return rows.length;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(
      JSON.stringify({ ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  let payload: PollRequest = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const baseUrl = (payload.base_url ?? SCOMM_BASE_URL).replace(/\/$/, "");
  const connectorCode = payload.connector_code ?? SCOMM_CONNECTOR_CODE;
  const connectorLabel = payload.connector_label ?? SCOMM_SERVICE_LABEL;
  const serviceRef = payload.service_ref ?? SCOMM_SERVICE_REF;
  const country = payload.country ?? SCOMM_COUNTRY;
  const noFilter = Boolean(payload.no_filter);

  if (!connectorCode) {
    return new Response(JSON.stringify({ ok: false, error: "Missing connector_code." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let connector: ConnectorRow | null = null;
  try {
    connector = await loadConnector(payload.connector_id, connectorCode, connectorLabel, baseUrl);
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!connector) {
    return new Response(JSON.stringify({ ok: false, error: "Connector not found or created." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let records: Array<Record<string, unknown>> = [];
  try {
    const url = `${baseUrl}/airrohr/v1/filter/country=${encodeURIComponent(country)}`;
    const raw = await fetchJsonWithRetry(url);
    if (Array.isArray(raw)) {
      records = raw as Array<Record<string, unknown>>;
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!records.length) {
    return new Response(JSON.stringify({ ok: true, count: 0, message: "No records returned." }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const filtered = noFilter
    ? records
    : records.filter((record) => stationInBboxOrMissingCoords(stationStub(record), UK_BBOX));

  const phenomenonIds = await upsertPhenomena(connector.id);
  await upsertStations(filtered, connector.id, serviceRef);

  const stationRefSet = new Set<string>();
  const timeseriesRefSet = new Set<string>();
  const observationsByTimeseries: Map<
    string,
    { station_ref: string; pollutant: string; value: number; observed_at: string; observed_ms: number }
  > = new Map();

  for (const record of filtered) {
    const normalized = normalizeStationPayload(record);
    if (!normalized.station_ref) {
      continue;
    }
    const stationRef = normalized.station_ref;
    stationRefSet.add(stationRef);
    const observedAt = parseTimestamp(record.timestamp) ?? new Date().toISOString();
    const observedMs = Date.parse(observedAt);
    const sensorValues = Array.isArray(record.sensordatavalues) ? record.sensordatavalues : [];
    for (const entry of sensorValues) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const valueType = (entry as Record<string, unknown>).value_type;
      const mapped = VALUE_TYPE_MAP[String(valueType)];
      if (!mapped) {
        continue;
      }
      const value = coerceNumber((entry as Record<string, unknown>).value);
      if (value === null) {
        continue;
      }
      const pollutant = mapped.pollutant;
      const timeseriesRef = `${stationRef}:${pollutant}`;
      timeseriesRefSet.add(timeseriesRef);
      const existing = observationsByTimeseries.get(timeseriesRef);
      if (!existing || observedMs > existing.observed_ms) {
        observationsByTimeseries.set(timeseriesRef, {
          station_ref: stationRef,
          pollutant,
          value,
          observed_at: observedAt,
          observed_ms: observedMs,
        });
      }
    }
  }

  const stationRefs = Array.from(stationRefSet);
  const stationIdMap = await fetchStationIds(connector.id, serviceRef, stationRefs);

  const timeseriesPayload: Array<Record<string, unknown>> = [];
  for (const entry of observationsByTimeseries.values()) {
    const stationId = stationIdMap[entry.station_ref];
    if (!stationId) {
      continue;
    }
    const meta = Object.values(VALUE_TYPE_MAP).find((item) => item.pollutant === entry.pollutant);
    const label = meta ? `${entry.station_ref} ${meta.label}` : entry.pollutant;
    timeseriesPayload.push({
      timeseries_ref: `${entry.station_ref}:${entry.pollutant}`,
      label,
      uom: meta ? meta.uom : null,
      station_id: stationId,
      connector_id: connector.id,
      service_ref: String(serviceRef),
      phenomenon_id: phenomenonIds[entry.pollutant],
      last_value_at: entry.observed_at,
      last_value: entry.value,
    });
  }
  await upsertTimeseries(timeseriesPayload);
  await backfillTimeseriesPhenomena(connector.id, serviceRef, phenomenonIds);

  const timeseriesRefs = Array.from(timeseriesRefSet);
  const timeseriesIdMap = await fetchTimeseriesIds(connector.id, serviceRef, timeseriesRefs);

  const observationRows: Array<Record<string, unknown>> = [];
  for (const entry of observationsByTimeseries.values()) {
    const timeseriesRef = `${entry.station_ref}:${entry.pollutant}`;
    const timeseriesId = timeseriesIdMap[timeseriesRef];
    if (!timeseriesId) {
      continue;
    }
    observationRows.push({
      timeseries_id: timeseriesId,
      observed_at: entry.observed_at,
      value: entry.value,
      status: null,
    });
  }

  const observationsUpserted = await upsertObservations(observationRows);

  await postgrestRequest(
    "PATCH",
    "connectors",
    { id: `eq.${connector.id}` },
    { last_polled_at: new Date().toISOString() },
    "return=minimal",
  );

  return new Response(
    JSON.stringify({
      ok: true,
      fetched: records.length,
      filtered: filtered.length,
      stations: stationRefs.length,
      timeseries: timeseriesPayload.length,
      observations: observationsUpserted,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
