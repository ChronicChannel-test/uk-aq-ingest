// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type PollRequest = {
  connector_id?: string;
  connector_code?: string;
  connector_label?: string;
  connector_display_name?: string;
  service_ref?: string;
  base_url?: string;
  group?: string;
  species?: string[] | string;
  station_refs?: string[] | string;
  days?: number;
  start_date?: string;
  end_date?: string;
  batch_size?: number;
  sleep_seconds?: number;
  dry_run?: boolean;
};

type ConnectorRow = {
  id: string;
  connector_code: string;
  label: string;
  display_name: string | null;
  service_url: string | null;
};

const DEFAULT_BASE_URL = "https://api.erg.ic.ac.uk/AirQuality";
const DEFAULT_CONNECTOR_CODE = "erg_laqn";
const DEFAULT_CONNECTOR_LABEL = "ERG London Air";
const DEFAULT_CONNECTOR_DISPLAY_NAME = "London Air LAQN";
const DEFAULT_USER_AGENT = "uk-air-quality-networks";
const DEFAULT_GROUP = "London";
const DEFAULT_SPECIES = ["NO2", "PM10", "PM25", "O3"];
const DEFAULT_DAYS = 1;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_SLEEP_SECONDS = 0.2;
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const SPECIES_CONFIG: Record<
  string,
  { label: string; uom: string; pollutant_label: string }
> = {
  NO2: { label: "NO2", uom: "ug/m3", pollutant_label: "no2" },
  PM10: { label: "PM10", uom: "ug/m3", pollutant_label: "pm10" },
  PM25: { label: "PM2.5", uom: "ug/m3", pollutant_label: "pm2.5" },
  O3: { label: "O3", uom: "ug/m3", pollutant_label: "o3" },
  SO2: { label: "SO2", uom: "ug/m3", pollutant_label: "so2" },
  CO: { label: "CO", uom: "mg/m3", pollutant_label: "co" },
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")
  ?? Deno.env.get("SB_SUPABASE_URL")
  ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  ?? Deno.env.get("SB_SERVICE_ROLE_KEY")
  ?? "";
const SB_UK_AQ_CRON_SECRET = Deno.env.get("SB_UK_AQ_CRON_SECRET") ?? "";

const LAQN_BASE_URL = (Deno.env.get("LAQN_BASE_URL") ?? DEFAULT_BASE_URL)
  .replace(/\/$/, "");
const LAQN_CONNECTOR_CODE = Deno.env.get("LAQN_CONNECTOR_CODE")
  ?? DEFAULT_CONNECTOR_CODE;
const LAQN_SERVICE_REF = Deno.env.get("LAQN_SERVICE_REF")
  ?? LAQN_CONNECTOR_CODE;
const LAQN_CONNECTOR_LABEL = Deno.env.get("LAQN_CONNECTOR_LABEL")
  ?? Deno.env.get("LAQN_SERVICE_LABEL")
  ?? DEFAULT_CONNECTOR_LABEL;
const LAQN_CONNECTOR_DISPLAY_NAME = Deno.env.get("LAQN_CONNECTOR_DISPLAY_NAME")
  ?? DEFAULT_CONNECTOR_DISPLAY_NAME;
const LAQN_USER_AGENT = Deno.env.get("LAQN_USER_AGENT")
  ?? DEFAULT_USER_AGENT;
const LAQN_DEFAULT_GROUP = Deno.env.get("LAQN_DEFAULT_GROUP") ?? DEFAULT_GROUP;

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
  if (!REST_BASE_URL) {
    return { data: null, error: { message: "Missing REST_BASE_URL" } };
  }
  const url = new URL(`${REST_BASE_URL}/${table}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  }
  const resp = await fetch(url.toString(), {
    method,
    headers: postgrestHeaders(prefer),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    let message = `${resp.status} ${resp.statusText}`;
    try {
      const errorPayload = await resp.json();
      if (errorPayload?.message) {
        message = errorPayload.message;
      }
    } catch {
      // ignore
    }
    return { data: null, error: { message } };
  }
  if (resp.status === 204 || resp.status === 201) {
    return { data: null, error: null };
  }
  const data = (await resp.json().catch(() => null)) as T | null;
  return { data, error: null };
}

async function fetchJson(
  url: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const requestUrl = new URL(url);
  if (params) {
    Object.entries(params).forEach(([key, value]) =>
      requestUrl.searchParams.set(key, value)
    );
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const resp = await fetch(requestUrl.toString(), {
        headers: { "User-Agent": LAQN_USER_AGENT },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (resp.status === 404) {
        throw new Error(`HTTP 404 for ${requestUrl}`);
      }
      if (RETRYABLE_STATUS.has(resp.status)) {
        await sleep(2 ** attempt);
        continue;
      }
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} for ${requestUrl}`);
      }
      return await resp.json();
    } catch (err) {
      clearTimeout(timeoutId);
      if (attempt === 3) {
        throw err;
      }
      await sleep(2 ** attempt);
    }
  }
  return null;
}

function sleep(seconds: number): Promise<void> {
  const ms = Math.max(0, seconds) * 1000;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSpeciesList(value: string[] | string | undefined): string[] {
  if (!value) {
    return [...DEFAULT_SPECIES];
  }
  const items = Array.isArray(value) ? value : value.split(",");
  const normalized = items.map((item) => String(item).trim().toUpperCase())
    .map((item) => item.replace(".", ""));
  return normalized.filter((item) => item.length > 0);
}

function parseStationRefs(value: string[] | string | undefined): string[] {
  if (!value) {
    return [];
  }
  const items = Array.isArray(value) ? value : value.split(",");
  return items.map((item) => String(item).trim().toUpperCase()).filter(Boolean);
}

function parseDate(value?: string | null): Date | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  let candidate = trimmed;
  if (!candidate.includes("T") && candidate.includes(" ")) {
    candidate = candidate.replace(" ", "T");
  }
  if (!candidate.endsWith("Z") && !candidate.includes("+")) {
    candidate = `${candidate}Z`;
  }
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function pickValue(payload: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in payload) {
      return payload[key];
    }
    const atKey = `@${key}`;
    if (atKey in payload) {
      return payload[atKey];
    }
    const lowerKey = key.toLowerCase();
    for (const [entryKey, entryValue] of Object.entries(payload)) {
      if (entryKey.toLowerCase() === lowerKey) {
        return entryValue;
      }
    }
  }
  return null;
}

function extractStations(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter((row) => typeof row === "object" && row !== null) as Record<string, unknown>[];
  }
  if (payload && typeof payload === "object") {
    const dict = payload as Record<string, unknown>;
    for (const key of ["Sites", "sites", "MonitoringSites", "monitoringSites", "data"]) {
      const value = dict[key];
      if (Array.isArray(value)) {
        return value.filter((row) => typeof row === "object" && row !== null) as Record<string, unknown>[];
      }
      if (value && typeof value === "object") {
        const nested = value as Record<string, unknown>;
        const sites = nested["Site"] ?? nested["site"];
        if (Array.isArray(sites)) {
          return sites.filter((row) => typeof row === "object" && row !== null) as Record<string, unknown>[];
        }
        if (sites && typeof sites === "object") {
          return [sites as Record<string, unknown>];
        }
      }
    }
    const sites = dict["Site"] ?? dict["site"];
    if (Array.isArray(sites)) {
      return sites.filter((row) => typeof row === "object" && row !== null) as Record<string, unknown>[];
    }
    if (sites && typeof sites === "object") {
      return [sites as Record<string, unknown>];
    }
  }
  return [];
}

function normalizeStation(
  station: Record<string, unknown>,
  connectorId: number,
): Record<string, unknown> | null {
  const stationRef = String(
    pickValue(station, ["SiteCode", "SiteID", "SiteId", "Site"]) ?? ""
  ).trim();
  if (!stationRef) {
    return null;
  }
  const label = String(pickValue(station, ["SiteName", "Label", "Name"]) ?? "")
    .trim();
  const latRaw = pickValue(station, ["Latitude", "Lat", "Northing"]);
  const lonRaw = pickValue(station, ["Longitude", "Lon", "Lng", "Easting"]);
  const latitude = latRaw !== null ? Number(latRaw) : null;
  const longitude = lonRaw !== null ? Number(lonRaw) : null;
  const geometry = Number.isFinite(latitude) && Number.isFinite(longitude)
    ? `SRID=4326;POINT(${longitude} ${latitude})`
    : null;

  return {
    station_ref: stationRef,
    service_ref: LAQN_SERVICE_REF,
    label: label || stationRef,
    station_name: label || stationRef,
    station_type: pickValue(station, ["SiteType", "SiteClassification", "Type"]) ?? null,
    station_exposure: pickValue(station, ["LocationType", "SiteLocation", "SiteLocationType"]) ??
      null,
    region: pickValue(station, ["LocalAuthority", "Borough", "Region", "LocalAuthorityName"]) ??
      null,
    geometry,
    first_seen_at: pickValue(station, ["StartDate", "SiteStartDate", "SiteSetupDate"]) ??
      null,
    last_seen_at: pickValue(station, ["LastUpdated", "LastCommunication", "LastSeen"]) ??
      null,
    removed_at: pickValue(station, ["EndDate", "SiteEndDate", "DateClosed"]) ?? null,
    connector_id: connectorId,
  };
}

function extractObservations(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.filter((row) => typeof row === "object" && row !== null) as Array<Record<string, unknown>>;
  }
  if (payload && typeof payload === "object") {
    const dict = payload as Record<string, unknown>;
    const raw = dict["RawAQData"] ?? dict["rawAQData"];
    const container = raw && typeof raw === "object" ? raw as Record<string, unknown> : dict;
    for (const key of ["RawData", "rawData", "Data", "data", "Measurements", "measurements"]) {
      const value = container[key];
      if (Array.isArray(value)) {
        return value.filter((row) => typeof row === "object" && row !== null) as Array<Record<string, unknown>>;
      }
    }
  }
  return [];
}

function parseObservationDate(value: unknown): Date | null {
  if (!value) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  let candidate = text;
  if (!candidate.includes("T") && candidate.includes(" ")) {
    candidate = candidate.replace(" ", "T");
  }
  if (!candidate.endsWith("Z") && !candidate.includes("+")) {
    candidate = `${candidate}Z`;
  }
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function chunk<T>(values: T[], size: number): T[][] {
  if (size <= 0) {
    return [values];
  }
  const result: T[][] = [];
  for (let idx = 0; idx < values.length; idx += size) {
    result.push(values.slice(idx, idx + size));
  }
  return result;
}

async function upsertConnector(
  connectorCode: string,
  connectorLabel: string,
  connectorDisplayName: string,
  serviceUrl: string,
): Promise<ConnectorRow | null> {
  const payload = {
    connector_code: connectorCode,
    label: connectorLabel,
    display_name: connectorDisplayName,
    service_url: serviceUrl,
    stations_bbox_supported: false,
    timeseries_station_filter_supported: false,
  };
  const { error: upsertError } = await postgrestRequest(
    "POST",
    "connectors",
    { on_conflict: "connector_code" },
    payload,
    "return=minimal",
  );
  if (upsertError) {
    throw new Error(`Connector upsert failed: ${upsertError.message}`);
  }
  const { data, error } = await postgrestRequest<ConnectorRow[]>(
    "GET",
    "connectors",
    { select: "id,connector_code,label,display_name,service_url", connector_code: `eq.${connectorCode}` },
  );
  if (error || !data?.length) {
    throw new Error(`Connector fetch failed: ${error?.message ?? "missing connector"}`);
  }
  return data[0];
}

async function upsertStations(rows: Record<string, unknown>[]): Promise<void> {
  if (!rows.length) {
    return;
  }
  const { error } = await postgrestRequest(
    "POST",
    "stations",
    { on_conflict: "connector_id,service_ref,station_ref" },
    rows,
    "return=minimal",
  );
  if (error) {
    throw new Error(`Stations upsert failed: ${error.message}`);
  }
}

async function fetchStationIds(
  connectorId: number,
  stationRefs: string[],
): Promise<Record<string, number>> {
  const mapping: Record<string, number> = {};
  for (const chunkRefs of chunk(stationRefs, 200)) {
    const { data, error } = await postgrestRequest<Array<{ id: number; station_ref: string }>>(
      "GET",
      "stations",
      {
        select: "id,station_ref",
        connector_id: `eq.${connectorId}`,
        service_ref: `eq.${LAQN_SERVICE_REF}`,
        station_ref: `in.(${chunkRefs.join(",")})`,
      },
    );
    if (error) {
      throw new Error(`Station id fetch failed: ${error.message}`);
    }
    for (const row of data ?? []) {
      mapping[String(row.station_ref)] = Number(row.id);
    }
  }
  return mapping;
}

async function upsertPhenomena(
  connectorId: number,
  speciesList: string[],
): Promise<void> {
  const payload = speciesList.map((species) => {
    const config = SPECIES_CONFIG[species] ?? {
      label: species,
      uom: null,
      pollutant_label: species.toLowerCase(),
    };
    return {
      connector_id: connectorId,
      label: config.label,
      eionet_uri: `laqn:${species}`,
      notation: species,
      pollutant_label: config.pollutant_label,
    };
  });
  const { error } = await postgrestRequest(
    "POST",
    "phenomena",
    { on_conflict: "connector_id,eionet_uri" },
    payload,
    "return=minimal",
  );
  if (error) {
    throw new Error(`Phenomena upsert failed: ${error.message}`);
  }
}

async function fetchPhenomenaIds(
  connectorId: number,
  speciesList: string[],
): Promise<Record<string, number>> {
  const mapping: Record<string, number> = {};
  const uris = speciesList.map((species) => `"laqn:${species}"`);
  const { data, error } = await postgrestRequest<Array<{ id: number; eionet_uri: string }>>(
    "GET",
    "phenomena",
    {
      select: "id,eionet_uri",
      connector_id: `eq.${connectorId}`,
      eionet_uri: `in.(${uris.join(",")})`,
    },
  );
  if (error) {
    throw new Error(`Phenomena fetch failed: ${error.message}`);
  }
  for (const row of data ?? []) {
    mapping[String(row.eionet_uri)] = Number(row.id);
  }
  return mapping;
}

async function upsertTimeseries(
  rows: Record<string, unknown>[],
): Promise<void> {
  if (!rows.length) {
    return;
  }
  const { error } = await postgrestRequest(
    "POST",
    "timeseries",
    { on_conflict: "connector_id,service_ref,timeseries_ref" },
    rows,
    "return=minimal",
  );
  if (error) {
    throw new Error(`Timeseries upsert failed: ${error.message}`);
  }
}

async function fetchTimeseriesIds(
  connectorId: number,
  timeseriesRefs: string[],
): Promise<Record<string, number>> {
  const mapping: Record<string, number> = {};
  for (const chunkRefs of chunk(timeseriesRefs, 200)) {
    const quoted = chunkRefs.map((value) => `"${value}"`);
    const { data, error } = await postgrestRequest<Array<{ id: number; timeseries_ref: string }>>(
      "GET",
      "timeseries",
      {
        select: "id,timeseries_ref",
        connector_id: `eq.${connectorId}`,
        service_ref: `eq.${LAQN_SERVICE_REF}`,
        timeseries_ref: `in.(${quoted.join(",")})`,
      },
    );
    if (error) {
      throw new Error(`Timeseries id fetch failed: ${error.message}`);
    }
    for (const row of data ?? []) {
      mapping[String(row.timeseries_ref)] = Number(row.id);
    }
  }
  return mapping;
}

async function upsertObservations(rows: Record<string, unknown>[]): Promise<number> {
  if (!rows.length) {
    return 0;
  }
  const { error } = await postgrestRequest(
    "POST",
    "observations",
    { on_conflict: "timeseries_id,observed_at" },
    rows,
    "return=minimal",
  );
  if (error) {
    throw new Error(`Observations upsert failed: ${error.message}`);
  }
  return rows.length;
}

async function updateTimeseriesLastValues(
  rows: Array<{ id: number; last_value: number; last_value_at: string }>,
): Promise<number> {
  let updated = 0;
  for (const row of rows) {
    const { error } = await postgrestRequest(
      "PATCH",
      "timeseries",
      { id: `eq.${row.id}` },
      { last_value: row.last_value, last_value_at: row.last_value_at },
      "return=minimal",
    );
    if (!error) {
      updated += 1;
    }
  }
  return updated;
}

async function updateConnectorLastPolled(connectorId: string): Promise<void> {
  const { error } = await postgrestRequest(
    "PATCH",
    "connectors",
    { id: `eq.${connectorId}` },
    { last_polled_at: new Date().toISOString() },
    "return=minimal",
  );
  if (error) {
    throw new Error(`Failed to update connectors.last_polled_at: ${error.message}`);
  }
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const authResponse = requireCronSecret(req);
  if (authResponse) {
    return authResponse;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(
      JSON.stringify({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  let payload: PollRequest = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const connectorCode = payload.connector_code ?? LAQN_CONNECTOR_CODE;
  const connectorLabel = payload.connector_label ?? LAQN_CONNECTOR_LABEL;
  const connectorDisplayName = payload.connector_display_name ?? LAQN_CONNECTOR_DISPLAY_NAME;
  const serviceRef = payload.service_ref ?? LAQN_SERVICE_REF;
  const baseUrl = (payload.base_url ?? LAQN_BASE_URL).replace(/\/$/, "");
  const groupName = payload.group ?? LAQN_DEFAULT_GROUP;
  const stationRefs = parseStationRefs(payload.station_refs);
  const speciesList = parseSpeciesList(payload.species);
  const days = payload.days ?? DEFAULT_DAYS;
  const batchSize = payload.batch_size ?? DEFAULT_BATCH_SIZE;
  const sleepSeconds = payload.sleep_seconds ?? DEFAULT_SLEEP_SECONDS;
  const dryRun = Boolean(payload.dry_run);

  const now = new Date();
  const endDate = parseDate(payload.end_date) ?? now;
  const startDate = parseDate(payload.start_date)
    ?? new Date(endDate.getTime() - Math.max(days, 1) * 24 * 60 * 60 * 1000);
  if (startDate > endDate) {
    const tmp = startDate;
    startDate.setTime(endDate.getTime());
    endDate.setTime(tmp.getTime());
  }
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  if (!speciesList.length) {
    return new Response(JSON.stringify({ error: "No species specified." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const connector = await upsertConnector(
      connectorCode,
      connectorLabel,
      connectorDisplayName,
      baseUrl,
    );
    const connectorId = connector?.id;
    if (!connectorId) {
      throw new Error("Connector id missing after upsert.");
    }

    const stationsPayload = await fetchJson(
      `${baseUrl}/Information/MonitoringSites/GroupName=${groupName}/Json`,
    );
    const rawStations = extractStations(stationsPayload);
    const filteredStations = stationRefs.length
      ? rawStations.filter((station) => {
        const ref = String(
          pickValue(station, ["SiteCode", "SiteID", "SiteId", "Site"]) ?? ""
        ).trim().toUpperCase();
        return stationRefs.includes(ref);
      })
      : rawStations;

    const stationRows = filteredStations.map((station) =>
      normalizeStation(station, Number(connectorId))
    ).filter((row) => row) as Record<string, unknown>[];
    if (!stationRows.length) {
      return new Response(JSON.stringify({ warning: "No stations selected." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!dryRun) {
      await upsertStations(stationRows);
    }
    const stationIdMap = await fetchStationIds(
      Number(connectorId),
      stationRows.map((row) => String(row.station_ref)),
    );
    if (!Object.keys(stationIdMap).length) {
      return new Response(JSON.stringify({ warning: "No station ids resolved." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!dryRun) {
      await upsertPhenomena(Number(connectorId), speciesList);
    }
    const phenomenonIds = await fetchPhenomenaIds(Number(connectorId), speciesList);

    const timeseriesRows: Record<string, unknown>[] = [];
    for (const row of stationRows) {
      const stationRef = String(row.station_ref);
      const stationId = stationIdMap[stationRef];
      if (!stationId) {
        continue;
      }
      const stationName = String(row.station_name ?? row.label ?? stationRef);
      for (const species of speciesList) {
        const config = SPECIES_CONFIG[species] ?? { label: species, uom: null };
        timeseriesRows.push({
          timeseries_ref: `${stationRef}:${species}`,
          label: `${stationName} ${config.label}`,
          uom: config.uom ?? null,
          station_id: stationId,
          service_ref: serviceRef,
          connector_id: Number(connectorId),
          phenomenon_id: phenomenonIds[`laqn:${species}`] ?? null,
          extras: { site_code: stationRef, species },
        });
      }
    }
    if (!dryRun) {
      await upsertTimeseries(timeseriesRows);
    }
    const timeseriesIdMap = await fetchTimeseriesIds(
      Number(connectorId),
      timeseriesRows.map((row) => String(row.timeseries_ref)),
    );

    let observationsUpserted = 0;
    const timeseriesUpdates: Array<{ id: number; last_value: number; last_value_at: string }> = [];

    for (const row of stationRows) {
      const stationRef = String(row.station_ref);
      for (const species of speciesList) {
        const timeseriesRef = `${stationRef}:${species}`;
        const timeseriesId = timeseriesIdMap[timeseriesRef];
        if (!timeseriesId) {
          continue;
        }
        const url = `${baseUrl}/Data/SiteSpecies/SiteCode=${stationRef}/SpeciesCode=${species}` +
          `/StartDate=${startStr}/EndDate=${endStr}/Json`;
        const payloadData = await fetchJson(url);
        const rawRows = extractObservations(payloadData);
        const observations: Record<string, unknown>[] = [];
        let lastObserved: Date | null = null;
        let lastValue: number | null = null;
        for (const entry of rawRows) {
          const observedAt = parseObservationDate(
            entry["@MeasurementDateGMT"]
              ?? entry["@MeasurementDate"]
              ?? entry["DateTimeGMT"]
              ?? entry["DateTime"]
              ?? entry["Date"]
          );
          const value = Number(
            entry["@Value"] ?? entry["Value"] ?? entry["ScaledValue"] ?? entry["RawValue"]
          );
          if (!observedAt || Number.isNaN(value)) {
            continue;
          }
          observations.push({
            timeseries_id: timeseriesId,
            observed_at: observedAt.toISOString(),
            value,
          });
          if (!lastObserved || observedAt > lastObserved) {
            lastObserved = observedAt;
            lastValue = value;
          }
        }
        if (observations.length && !dryRun) {
          for (const batch of chunk(observations, batchSize)) {
            observationsUpserted += await upsertObservations(batch);
          }
        }
        if (lastObserved && lastValue !== null) {
          timeseriesUpdates.push({
            id: timeseriesId,
            last_value: lastValue,
            last_value_at: lastObserved.toISOString(),
          });
        }
        if (sleepSeconds) {
          await sleep(sleepSeconds);
        }
      }
    }

    let timeseriesUpdated = 0;
    if (!dryRun && timeseriesUpdates.length) {
      timeseriesUpdated = await updateTimeseriesLastValues(timeseriesUpdates);
    }
    if (!dryRun) {
      await updateConnectorLastPolled(connectorId);
    }

    return new Response(
      JSON.stringify(
        {
          connector_id: connectorId,
          group: groupName,
          stations: stationRows.length,
          species: speciesList,
          observations_upserted: observationsUpserted,
          timeseries_updated: timeseriesUpdated,
          dry_run: dryRun,
        },
        null,
        2,
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
