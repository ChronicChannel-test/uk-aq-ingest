import { deflateRawSync } from "node:zlib";

const CONNECTOR_CODE = "sensorcommunity";
const SCHEDULER_BACKEND_SUPABASE_FUNCTION = "supabase_function";
const SCHEDULER_BACKEND_GOOGLE_CLOUD_RUN = "google_cloud_run";

const DEFAULT_INTERVAL_MINUTES = parsePositiveInt(
  process.env.SCOMM_DEFAULT_INTERVAL_MINUTES,
  15,
);
const IN_FLIGHT_TIMEOUT_MINUTES = parsePositiveInt(
  process.env.SCOMM_IN_FLIGHT_TIMEOUT_MINUTES,
  30,
);
const CLAIM_TIMEOUT_MINUTES = parsePositiveInt(
  process.env.SCOMM_CLAIM_TIMEOUT_MINUTES,
  30,
);
const HTTP_TIMEOUT_MS = parsePositiveInt(
  process.env.SCOMM_HTTP_TIMEOUT_MS,
  60_000,
);
const SOURCE_FETCH_TIMEOUT_MS = parsePositiveInt(
  process.env.SCOMM_SOURCE_TIMEOUT_MS,
  90_000,
);
const SOURCE_FETCH_RETRIES = parsePositiveInt(
  process.env.SCOMM_SOURCE_RETRIES,
  3,
);
const UPSERT_CHUNK_SIZE = parsePositiveInt(
  process.env.SCOMM_UPSERT_CHUNK_SIZE,
  500,
);
const SCOMM_COUNTRY = process.env.SCOMM_COUNTRY || "GB";
const SCOMM_BASE_URL = (process.env.SCOMM_BASE_URL || "https://data.sensor.community").replace(/\/$/, "");
const SCOMM_SERVICE_REF = process.env.SCOMM_SERVICE_REF || CONNECTOR_CODE;
const SCOMM_USER_AGENT = process.env.SCOMM_USER_AGENT || "uk-air-quality-networks";
const SCOMM_INGEST_MET_FIELDS = parseBool(process.env.SCOMM_INGEST_MET_FIELDS, false);

const SUPABASE_URL = requiredEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const UK_AQ_CORE_SCHEMA = process.env.UK_AQ_CORE_SCHEMA || "uk_aq_core";
const UK_AQ_RAW_SCHEMA = process.env.UK_AQ_RAW_SCHEMA || "uk_aq_raw";
const REST_BASE_URL = buildRestBaseUrl(SUPABASE_URL);

const HISTORY_SUPABASE_URL = (process.env.HISTORY_SUPABASE_URL || "").trim();
const HISTORY_SERVICE_ROLE_KEY = (process.env.HISTORY_SERVICE_ROLE_KEY || "").trim();
const HISTORY_SCHEMA = (
  process.env.HISTORY_SCHEMA ||
  process.env.HISTORY_DB_SCHEMA ||
  "uk_aq_public"
).trim();
const HISTORY_RPC_SCHEMA = normalizeHistoryRpcSchema(HISTORY_SCHEMA);
const HISTORY_UPSERT_RPC = (
  process.env.HISTORY_UPSERT_RPC ||
  "uk_aq_rpc_history_observations_upsert"
).trim();
const HISTORY_UPSERT_CHUNK_SIZE = parsePositiveInt(
  process.env.HISTORY_UPSERT_CHUNK_SIZE,
  2000,
);
const HISTORY_REST_BASE_URL = HISTORY_SUPABASE_URL
  ? buildRestBaseUrl(HISTORY_SUPABASE_URL)
  : "";

const DROPBOX_APP_KEY = (process.env.DROPBOX_APP_KEY || "").trim();
const DROPBOX_APP_SECRET = (process.env.DROPBOX_APP_SECRET || "").trim();
const DROPBOX_REFRESH_TOKEN = (process.env.DROPBOX_REFRESH_TOKEN || "").trim();
const DROPBOX_ALLOWED_SUPABASE_URL = (
  process.env.SCOMM_RAW_DROPBOX_ALLOWED_SUPABASE_URL ||
  process.env.UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL ||
  ""
).trim();
const DROPBOX_ROOT_FOLDER = (() => {
  const raw = process.env.SCOMM_DROPBOX_ROOT ||
    process.env.UK_AQ_DROPBOX_ROOT ||
    "";
  return normalizeDropboxPath(raw);
})();
const DROPBOX_LOG_FOLDER = dropboxWithRoot(
  process.env.SCOMM_LOG_DROPBOX_FOLDER ||
    process.env.UK_AIR_LOG_DROPBOX_FOLDER ||
    "/connectors/sensorcommunity/log",
);
const DROPBOX_RAW_FOLDER = dropboxWithRoot(
  process.env.SCOMM_RAW_DROPBOX_FOLDER ||
    process.env.UK_AIR_RAW_DROPBOX_FOLDER ||
    "/connectors/sensorcommunity/raw_data",
);
const DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const DROPBOX_UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload";

const UK_BBOX = {
  west: -11.0,
  south: 49.0,
  east: 2.0,
  north: 61.0,
};

const BASE_VALUE_TYPE_MAP = {
  P1: { pollutant: "pm10", label: "PM10", uom: "ug/m3" },
  P2: { pollutant: "pm2.5", label: "PM2.5", uom: "ug/m3" },
};

const VALUE_TYPE_MAP = {
  ...BASE_VALUE_TYPE_MAP,
  ...(SCOMM_INGEST_MET_FIELDS
    ? {
        temperature: {
          pollutant: "temperature",
          label: "Temperature",
          uom: "degC",
        },
        humidity: {
          pollutant: "humidity",
          label: "Humidity",
          uom: "%",
        },
        pressure: {
          pollutant: "pressure",
          label: "Pressure",
          uom: "hPa",
        },
      }
    : {}),
};

const BASE_SCOMM_PHENOMENA = {
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

const SCOMM_PHENOMENA = {
  ...BASE_SCOMM_PHENOMENA,
  ...(SCOMM_INGEST_MET_FIELDS
    ? {
        temperature: {
          eionet_uri: "sensorcommunity:temperature",
          label: "Temperature",
          notation: "temperature",
          pollutant_label: "temperature",
        },
        humidity: {
          eionet_uri: "sensorcommunity:humidity",
          label: "Humidity",
          notation: "humidity",
          pollutant_label: "humidity",
        },
        pressure: {
          eionet_uri: "sensorcommunity:pressure",
          label: "Pressure",
          notation: "pressure",
          pollutant_label: "pressure",
        },
      }
    : {}),
};

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function requiredEnv(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePositiveInt(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function parseBool(raw, fallback = false) {
  if (raw === undefined || raw === null) {
    return fallback;
  }
  const value = String(raw).trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "y", "on"].includes(value);
}

function normalizeHistoryRpcSchema(raw) {
  const normalized = String(raw || "").trim().toLowerCase();
  if (!normalized || normalized === "uk_aq_history" || normalized === "public") {
    return "uk_aq_public";
  }
  return String(raw).trim();
}

function toIntegerOrNull(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.trunc(numeric);
}

function toStringOrNull(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function toObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function coerceNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric;
}

function parseTimestamp(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function parseObservedAt(value) {
  if (!value || typeof value !== "string") {
    return new Date().toISOString();
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return new Date().toISOString();
  }

  let normalized = trimmed;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    normalized = `${trimmed.replace(" ", "T")}Z`;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    normalized = `${trimmed}Z`;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

function buildRestBaseUrl(url) {
  return `${String(url || "").replace(/\/$/, "")}/rest/v1`;
}

function historyConfigured() {
  return Boolean(HISTORY_SUPABASE_URL && HISTORY_SERVICE_ROLE_KEY);
}

function postgrestHeaders(schema, apiKey, write = false) {
  const headers = {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Accept-Profile": schema,
  };
  if (write) {
    headers["Content-Type"] = "application/json";
    headers["Content-Profile"] = schema;
  }
  return headers;
}

function withQuery(restBaseUrl, path, query) {
  const url = new URL(`${restBaseUrl}/${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function postgrestRequest(method, path, options = {}) {
  const schema = options.schema || UK_AQ_CORE_SCHEMA;
  const timeoutMs = options.timeoutMs || HTTP_TIMEOUT_MS;
  const apiKey = options.apiKey || SUPABASE_SERVICE_ROLE_KEY;
  const restBaseUrl = options.restBaseUrl || REST_BASE_URL;
  const url = withQuery(restBaseUrl, path, options.query);
  const write = method !== "GET";
  const headers = postgrestHeaders(schema, apiKey, write);
  if (options.prefer) {
    headers.Prefer = options.prefer;
  }

  const init = {
    method,
    headers,
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  const response = await fetchWithTimeout(url, init, timeoutMs);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
    text,
  };
}

async function historyPostgrestRequest(method, path, options = {}) {
  if (!historyConfigured()) {
    throw new Error(
      "History DB is not configured (missing HISTORY_SUPABASE_URL or HISTORY_SERVICE_ROLE_KEY).",
    );
  }
  return postgrestRequest(method, path, {
    ...options,
    schema: options.schema || HISTORY_RPC_SCHEMA,
    apiKey: HISTORY_SERVICE_ROLE_KEY,
    restBaseUrl: HISTORY_REST_BASE_URL,
  });
}

async function mainRpcRequest(fn, args = {}) {
  return postgrestRequest("POST", `rpc/${fn}`, {
    schema: "uk_aq_public",
    body: args,
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url, retries = SOURCE_FETCH_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(
        url,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": SCOMM_USER_AGENT,
          },
        },
        SOURCE_FETCH_TIMEOUT_MS,
      );
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      await wait(Math.min(30_000, 2 ** attempt * 1_000));
      continue;
    }

    const text = await response.text();
    if (response.ok) {
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error("Sensor.Community response was not valid JSON.");
      }
      if (!Array.isArray(payload)) {
        throw new Error("Sensor.Community response was not an array.");
      }
      return payload;
    }

    if (!RETRYABLE_STATUS.has(response.status) || attempt === retries) {
      throw new Error(
        `Sensor.Community request failed (${response.status}): ${text}`,
      );
    }

    await wait(Math.min(30_000, 2 ** attempt * 1_000));
  }

  return [];
}

function chunk(values, size) {
  const chunkSize = Math.max(1, Number(size) || 1);
  const result = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    result.push(values.slice(index, index + chunkSize));
  }
  return result;
}

function encodeInFilter(values) {
  return `(${values
    .map((value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",")})`;
}

function maybeSwapCoords(lon, lat, bbox) {
  if (lon === null || lat === null || !bbox) {
    return [lon, lat];
  }
  const lonLooksLikeLat = lon >= bbox.south && lon <= bbox.north;
  const latLooksLikeLon = lat >= bbox.west && lat <= bbox.east;
  const lonInLonRange = lon >= bbox.west && lon <= bbox.east;
  const latInLatRange = lat >= bbox.south && lat <= bbox.north;

  if (lonLooksLikeLat && latLooksLikeLon && !lonInLonRange && !latInLatRange) {
    return [lat, lon];
  }
  return [lon, lat];
}

function stationCoords(record) {
  const location = toObject(record?.location) || {};
  let lon =
    coerceNumber(location.longitude) ??
    coerceNumber(location.lon) ??
    coerceNumber(location.lng);
  let lat = coerceNumber(location.latitude) ?? coerceNumber(location.lat);

  [lon, lat] = maybeSwapCoords(lon, lat, UK_BBOX);

  return [lon, lat];
}

function stationInBboxOrMissingCoords(record) {
  const [lon, lat] = stationCoords(record);
  if (lon === null || lat === null) {
    return true;
  }
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    return false;
  }
  return (
    lon >= UK_BBOX.west &&
    lon <= UK_BBOX.east &&
    lat >= UK_BBOX.south &&
    lat <= UK_BBOX.north
  );
}

function stationExposure(location) {
  if (!location || typeof location !== "object") {
    return null;
  }
  const indoor = location.indoor;
  if (indoor === null || indoor === undefined) {
    return null;
  }
  if (typeof indoor === "boolean") {
    return indoor ? "indoor" : "outdoor";
  }
  if (typeof indoor === "number") {
    if (indoor === 1) {
      return "indoor";
    }
    if (indoor === 0) {
      return "outdoor";
    }
    return null;
  }
  if (typeof indoor === "string") {
    const value = indoor.trim().toLowerCase();
    if (["1", "true", "yes", "y"].includes(value)) {
      return "indoor";
    }
    if (["0", "false", "no", "n"].includes(value)) {
      return "outdoor";
    }
  }
  return null;
}

function normalizeStationPayload(record) {
  const location = toObject(record?.location) || {};
  const sensor = toObject(record?.sensor) || {};
  const sensorType = toObject(record?.sensor_type) || {};
  const [lon, lat] = stationCoords(record);

  const stationRefRaw = sensor.id ?? record?.sensor_id ?? record?.id;
  const stationRef =
    stationRefRaw !== undefined && stationRefRaw !== null
      ? String(stationRefRaw)
      : null;
  const label =
    toStringOrNull(location.name) || toStringOrNull(record?.location_name);

  return {
    station_ref: stationRef,
    label,
    station_name: label,
    station_type:
      toStringOrNull(sensorType.name) || toStringOrNull(sensorType.id),
    station_exposure: stationExposure(location),
    longitude: lon,
    latitude: lat,
  };
}

function mergeStationRow(existing, candidate) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(candidate)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === "string" && !value.trim()) {
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function buildObservationMap(records) {
  const observationsByTimeseries = new Map();
  const stationRefs = new Set();
  const timeseriesRefs = new Set();

  for (const record of records) {
    const normalized = normalizeStationPayload(record);
    const stationRef = normalized.station_ref;
    if (!stationRef) {
      continue;
    }
    stationRefs.add(stationRef);

    const observedAt = parseObservedAt(record?.timestamp);
    const observedMs = Date.parse(observedAt);

    const sensorValues = Array.isArray(record?.sensordatavalues)
      ? record.sensordatavalues
      : [];

    for (const entry of sensorValues) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const valueType = entry.value_type;
      const mapped = VALUE_TYPE_MAP[String(valueType)];
      if (!mapped) {
        continue;
      }
      const value = coerceNumber(entry.value);
      if (value === null) {
        continue;
      }

      const pollutant = mapped.pollutant;
      const timeseriesRef = `${stationRef}:${pollutant}`;
      timeseriesRefs.add(timeseriesRef);
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

  return {
    stationRefs: Array.from(stationRefs),
    timeseriesRefs: Array.from(timeseriesRefs),
    observationsByTimeseries,
  };
}

function evaluateDue(connector, now) {
  if (connector?.poll_enabled !== true) {
    return {
      due: false,
      reason: "poll_disabled",
      intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    };
  }

  const schedulerBackend =
    connector.scheduler_backend || SCHEDULER_BACKEND_SUPABASE_FUNCTION;
  if (schedulerBackend !== SCHEDULER_BACKEND_GOOGLE_CLOUD_RUN) {
    return {
      due: false,
      reason: "scheduler_backend_not_cloud_run",
      intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    };
  }

  const intervalMinutes =
    toIntegerOrNull(connector.poll_interval_minutes) || DEFAULT_INTERVAL_MINUTES;

  const runStartedAt = parseTimestamp(connector.last_run_start);
  const runEndedAt = parseTimestamp(connector.last_run_end);
  if (runStartedAt && !runEndedAt) {
    const runningGuardMs =
      Math.max(intervalMinutes, IN_FLIGHT_TIMEOUT_MINUTES) * 60 * 1000;
    const ageMs = now.getTime() - runStartedAt.getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < runningGuardMs) {
      return {
        due: false,
        reason: "in_flight",
        intervalMinutes,
      };
    }
  }

  const anchor = runStartedAt || parseTimestamp(connector.last_polled_at);
  if (!anchor) {
    return { due: true, reason: "first_run", intervalMinutes };
  }

  const elapsedMs = now.getTime() - anchor.getTime();
  if (elapsedMs < intervalMinutes * 60 * 1000) {
    return { due: false, reason: "not_due", intervalMinutes };
  }

  return { due: true, reason: "due", intervalMinutes };
}

async function loadConnector() {
  const response = await postgrestRequest("GET", "connectors", {
    query: {
      select:
        "id,connector_code,poll_enabled,poll_interval_minutes,scheduler_backend,last_polled_at,last_run_start,last_run_end,last_run_status,overwrite_station_name",
      connector_code: `eq.${CONNECTOR_CODE}`,
      limit: 1,
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to load connector (${response.status}): ${response.text}`,
    );
  }
  const rows = Array.isArray(response.data) ? response.data : [];
  return rows[0] || null;
}

async function claimConnector(runStartedAtIso) {
  const response = await postgrestRequest("POST", "rpc/uk_aq_rpc_dispatch_claim", {
    schema: "uk_aq_public",
    body: {
      p_connector_code: CONNECTOR_CODE,
      p_run_started_at: runStartedAtIso,
      p_timeout_minutes: CLAIM_TIMEOUT_MINUTES,
    },
  });
  if (!response.ok) {
    throw new Error(
      `Dispatch claim failed (${response.status}): ${response.text}`,
    );
  }
  const rows = Array.isArray(response.data) ? response.data : [];
  return rows[0] || null;
}

async function upsertRows(table, rows, onConflict, schema = UK_AQ_CORE_SCHEMA) {
  if (!rows.length) {
    return;
  }

  for (const rowsChunk of chunk(rows, UPSERT_CHUNK_SIZE)) {
    const response = await postgrestRequest("POST", table, {
      schema,
      query: { on_conflict: onConflict },
      body: rowsChunk,
      prefer: "resolution=merge-duplicates,return=minimal",
    });
    if (!response.ok) {
      throw new Error(
        `Failed to upsert ${table} (${response.status}): ${response.text}`,
      );
    }
  }
}

async function fetchStationNames(connectorId, serviceRef, stationRefs) {
  const mapping = {};
  if (!stationRefs.length) {
    return mapping;
  }

  for (const refsChunk of chunk(stationRefs, 200)) {
    const response = await postgrestRequest("GET", "stations", {
      query: {
        select: "station_ref,station_name",
        connector_id: `eq.${connectorId}`,
        service_ref: `eq.${serviceRef}`,
        station_ref: `in.${encodeInFilter(refsChunk)}`,
      },
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch station names (${response.status}): ${response.text}`,
      );
    }
    const rows = Array.isArray(response.data) ? response.data : [];
    for (const row of rows) {
      const stationRef = toStringOrNull(row?.station_ref);
      if (!stationRef) {
        continue;
      }
      mapping[stationRef] = toStringOrNull(row?.station_name);
    }
  }

  return mapping;
}

async function upsertStations(records, connectorId, serviceRef, overwriteStationName) {
  const rowsByRef = new Map();

  for (const record of records) {
    const normalized = normalizeStationPayload(record);
    if (!normalized.station_ref) {
      continue;
    }

    const row = {
      station_ref: normalized.station_ref,
      service_ref: String(serviceRef),
      label: normalized.label || `Sensor.Community ${normalized.station_ref}`,
      station_name: normalized.station_name,
      station_type: normalized.station_type,
      station_exposure: normalized.station_exposure,
      geometry:
        normalized.longitude !== null && normalized.latitude !== null
          ? `SRID=4326;POINT(${normalized.longitude} ${normalized.latitude})`
          : null,
      connector_id: connectorId,
      last_seen_at: new Date().toISOString(),
      removed_at: null,
    };

    const existing = rowsByRef.get(normalized.station_ref);
    if (existing) {
      rowsByRef.set(normalized.station_ref, mergeStationRow(existing, row));
    } else {
      rowsByRef.set(normalized.station_ref, row);
    }
  }

  const rows = Array.from(rowsByRef.values());

  if (!overwriteStationName && rows.length) {
    const stationRefs = rows
      .map((row) => toStringOrNull(row.station_ref))
      .filter((value) => Boolean(value));
    const existingNames = await fetchStationNames(connectorId, serviceRef, stationRefs);
    for (const row of rows) {
      const stationRef = toStringOrNull(row.station_ref);
      if (!stationRef) {
        continue;
      }
      const existingName = existingNames[stationRef];
      if (existingName && row.station_name) {
        delete row.station_name;
      }
    }
  }

  await upsertRows(
    "stations",
    rows,
    "connector_id,service_ref,station_ref",
    UK_AQ_CORE_SCHEMA,
  );

  return rows.length;
}

async function fetchStationIds(connectorId, serviceRef, stationRefs) {
  const mapping = {};
  if (!stationRefs.length) {
    return mapping;
  }

  for (const refsChunk of chunk(stationRefs, 200)) {
    const response = await postgrestRequest("GET", "stations", {
      query: {
        select: "id,station_ref",
        connector_id: `eq.${connectorId}`,
        service_ref: `eq.${serviceRef}`,
        station_ref: `in.${encodeInFilter(refsChunk)}`,
      },
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch station ids (${response.status}): ${response.text}`,
      );
    }
    const rows = Array.isArray(response.data) ? response.data : [];
    for (const row of rows) {
      const stationRef = toStringOrNull(row?.station_ref);
      const stationId = toIntegerOrNull(row?.id);
      if (!stationRef || stationId === null) {
        continue;
      }
      mapping[stationRef] = stationId;
    }
  }

  return mapping;
}

async function upsertPhenomena(connectorId) {
  const payload = Object.values(SCOMM_PHENOMENA).map((meta) => ({
    connector_id: connectorId,
    eionet_uri: meta.eionet_uri,
    label: meta.label,
    notation: meta.notation,
    pollutant_label: meta.pollutant_label,
  }));

  await upsertRows(
    "phenomena",
    payload,
    "connector_id,eionet_uri",
    UK_AQ_CORE_SCHEMA,
  );

  const uris = payload.map((row) => row.eionet_uri);
  const response = await postgrestRequest("GET", "phenomena", {
    query: {
      select: "id,eionet_uri",
      connector_id: `eq.${connectorId}`,
      eionet_uri: `in.${encodeInFilter(uris)}`,
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch phenomena ids (${response.status}): ${response.text}`,
    );
  }

  const rows = Array.isArray(response.data) ? response.data : [];
  const idsByUri = {};
  for (const row of rows) {
    const uri = toStringOrNull(row?.eionet_uri);
    const id = toIntegerOrNull(row?.id);
    if (!uri || id === null) {
      continue;
    }
    idsByUri[uri] = id;
  }

  const idsByPollutant = {};
  for (const [pollutant, meta] of Object.entries(SCOMM_PHENOMENA)) {
    const id = idsByUri[meta.eionet_uri];
    if (id !== undefined) {
      idsByPollutant[pollutant] = id;
    }
  }

  return idsByPollutant;
}

async function upsertTimeseries(rows) {
  await upsertRows(
    "timeseries",
    rows,
    "connector_id,service_ref,timeseries_ref",
    UK_AQ_CORE_SCHEMA,
  );
}

async function fetchTimeseriesIds(connectorId, serviceRef, timeseriesRefs) {
  const mapping = {};
  if (!timeseriesRefs.length) {
    return mapping;
  }

  for (const refsChunk of chunk(timeseriesRefs, 200)) {
    const response = await postgrestRequest("GET", "timeseries", {
      query: {
        select: "id,timeseries_ref",
        connector_id: `eq.${connectorId}`,
        service_ref: `eq.${serviceRef}`,
        timeseries_ref: `in.${encodeInFilter(refsChunk)}`,
      },
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch timeseries ids (${response.status}): ${response.text}`,
      );
    }
    const rows = Array.isArray(response.data) ? response.data : [];
    for (const row of rows) {
      const ref = toStringOrNull(row?.timeseries_ref);
      const id = toIntegerOrNull(row?.id);
      if (!ref || id === null) {
        continue;
      }
      mapping[ref] = id;
    }
  }

  return mapping;
}

async function upsertObservations(rows) {
  if (!rows.length) {
    return 0;
  }

  let count = 0;
  for (const rowsChunk of chunk(rows, UPSERT_CHUNK_SIZE)) {
    const response = await postgrestRequest("POST", "observations", {
      query: { on_conflict: "connector_id,timeseries_id,observed_at" },
      body: rowsChunk,
      prefer: "resolution=merge-duplicates,return=minimal",
    });
    if (!response.ok) {
      throw new Error(
        `Failed to upsert observations (${response.status}): ${response.text}`,
      );
    }
    count += rowsChunk.length;
  }

  return count;
}

function toObservedDay(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length >= 10) {
      return trimmed.slice(0, 10);
    }
  }
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

function countRowsFromPayload(payload, field, fallback) {
  const value = Number(payload?.[0]?.[field] ?? fallback);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function shortError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 400 ? `${message.slice(0, 397)}...` : message;
}

function toHistoryObservationRow(
  observationRow,
  connectorCode,
  serviceRef,
  timeseriesRef,
) {
  const observedAt = String(observationRow?.observed_at || "").trim();
  if (!observedAt) {
    return null;
  }
  const numericValue = Number(observationRow?.value);
  return {
    connector_code: connectorCode,
    service_ref: serviceRef,
    timeseries_ref: timeseriesRef,
    observed_at: observedAt,
    value: Number.isFinite(numericValue) ? numericValue : null,
    status: observationRow?.status == null ? null : String(observationRow.status),
    connector_id: Number(observationRow?.connector_id),
    timeseries_id: Number(observationRow?.timeseries_id),
  };
}

function buildHistorySyncReceipts(rows) {
  const dedup = new Map();
  for (const row of rows) {
    const connectorId = Number(row.connector_id);
    const timeseriesId = Number(row.timeseries_id);
    const observedDay = toObservedDay(row.observed_at);
    if (!Number.isFinite(connectorId) || !Number.isFinite(timeseriesId) || !observedDay) {
      continue;
    }
    const key = `${connectorId}:${timeseriesId}:${observedDay}`;
    dedup.set(key, {
      connector_id: connectorId,
      timeseries_id: timeseriesId,
      observed_day: observedDay,
    });
  }
  return Array.from(dedup.values());
}

async function historyUpsertObservations(historyRows) {
  if (!historyRows.length) {
    return 0;
  }

  let written = 0;
  for (const rowsChunk of chunk(historyRows, HISTORY_UPSERT_CHUNK_SIZE)) {
    const response = await historyPostgrestRequest(
      "POST",
      `rpc/${HISTORY_UPSERT_RPC}`,
      { body: { rows: rowsChunk } },
    );
    if (!response.ok) {
      throw new Error(
        `History upsert failed (${response.status}): ${response.text}`,
      );
    }
    written += countRowsFromPayload(
      Array.isArray(response.data) ? response.data : null,
      "observations_upserted",
      rowsChunk.length,
    );
  }
  return written;
}

async function upsertHistorySyncReceipts(rows) {
  if (!rows.length) {
    return 0;
  }
  const response = await mainRpcRequest(
    "uk_aq_rpc_history_sync_receipt_daily_upsert",
    { rows },
  );
  if (!response.ok) {
    throw new Error(
      `History receipt upsert failed (${response.status}): ${response.text}`,
    );
  }
  return countRowsFromPayload(
    Array.isArray(response.data) ? response.data : null,
    "rows_upserted",
    rows.length,
  );
}

async function enqueueHistoryOutbox(historyRows) {
  if (!historyRows.length) {
    return 0;
  }
  const response = await mainRpcRequest("uk_aq_rpc_history_outbox_enqueue", {
    entries: [{ payload: historyRows }],
  });
  if (!response.ok) {
    throw new Error(
      `History outbox enqueue failed (${response.status}): ${response.text}`,
    );
  }
  return countRowsFromPayload(
    Array.isArray(response.data) ? response.data : null,
    "rows_enqueued",
    1,
  );
}

async function writeHistoryWithOutbox(historyRows) {
  if (!historyRows.length) {
    return { written: 0, receipts_upserted: 0, enqueued: 0 };
  }
  if (!historyConfigured()) {
    return { written: 0, receipts_upserted: 0, enqueued: 0 };
  }

  try {
    const written = await historyUpsertObservations(historyRows);
    const receipts = buildHistorySyncReceipts(historyRows);
    const receiptsUpserted = await upsertHistorySyncReceipts(receipts);
    return {
      written,
      receipts_upserted: receiptsUpserted,
      enqueued: 0,
    };
  } catch (error) {
    const enqueued = await enqueueHistoryOutbox(historyRows);
    logSummary("history_dual_write_warning", {
      rows: historyRows.length,
      message: shortError(error),
      enqueued,
    });
    return {
      written: 0,
      receipts_upserted: 0,
      enqueued,
    };
  }
}

function normalizeDropboxPath(raw) {
  const cleaned = String(raw || "").trim();
  if (!cleaned) {
    return "";
  }
  const rooted = cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
  return rooted.replace(/\/$/, "");
}

function dropboxWithRoot(path) {
  const cleaned = normalizeDropboxPath(path);
  if (!DROPBOX_ROOT_FOLDER) {
    return cleaned;
  }
  if (!cleaned) {
    return DROPBOX_ROOT_FOLDER;
  }
  if (
    cleaned === DROPBOX_ROOT_FOLDER ||
    cleaned.startsWith(`${DROPBOX_ROOT_FOLDER}/`)
  ) {
    return cleaned;
  }
  return `${DROPBOX_ROOT_FOLDER}${cleaned}`;
}

function normalizeConnectorPrefix(connectorCode) {
  const cleaned = String(connectorCode || "").trim().toLowerCase();
  if (cleaned === "sensorcommunity") {
    return "scomm";
  }
  const normalized = cleaned.replace(/[^a-z0-9]+/g, "_").replace(
    /^_+|_+$/g,
    "",
  );
  return normalized || "scomm";
}

function formatCompactTimestamp(timestamp) {
  return timestamp.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function formatDateYmd(timestamp) {
  return timestamp.toISOString().slice(0, 10);
}

function buildDropboxLogPath(connectorCode, timestamp) {
  const stamp = formatCompactTimestamp(timestamp);
  const dateFolder = formatDateYmd(timestamp);
  const prefix = normalizeConnectorPrefix(connectorCode);
  return `${DROPBOX_LOG_FOLDER}/${dateFolder}/uk_aq_log_cloud_run_${prefix}_${stamp}.json`;
}

function buildDropboxRawPath(connectorCode, timestamp) {
  const stamp = formatCompactTimestamp(timestamp);
  const dateFolder = formatDateYmd(timestamp);
  const prefix = normalizeConnectorPrefix(connectorCode);
  return `${DROPBOX_RAW_FOLDER}/${dateFolder}/uk_aq_raw_cloud_run_${prefix}_${stamp}.zip`;
}

function loadDropboxConfig() {
  if (!DROPBOX_APP_KEY || !DROPBOX_APP_SECRET || !DROPBOX_REFRESH_TOKEN) {
    return null;
  }
  if (
    !DROPBOX_ALLOWED_SUPABASE_URL ||
    DROPBOX_ALLOWED_SUPABASE_URL !== SUPABASE_URL
  ) {
    return null;
  }
  return {
    appKey: DROPBOX_APP_KEY,
    appSecret: DROPBOX_APP_SECRET,
    refreshToken: DROPBOX_REFRESH_TOKEN,
  };
}

async function dropboxRefreshAccessToken(config) {
  const credentials = Buffer.from(`${config.appKey}:${config.appSecret}`).toString(
    "base64",
  );
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: config.refreshToken,
  });
  const response = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`Dropbox token request failed (${response.status})`);
  }
  const payload = await response.json();
  const accessToken = String(payload?.access_token || "").trim();
  if (!accessToken) {
    throw new Error("Dropbox token response missing access_token.");
  }
  return accessToken;
}

async function dropboxUploadFile(accessToken, path, contents) {
  const response = await fetch(DROPBOX_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        path,
        mode: "overwrite",
        mute: true,
      }),
    },
    body: contents,
  });
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Dropbox upload failed (${response.status}): ${text}`);
    error.status = response.status;
    throw error;
  }
}

async function dropboxUploadFileWithRetry(
  accessToken,
  path,
  contents,
  refreshToken,
) {
  try {
    await dropboxUploadFile(accessToken, path, contents);
    return accessToken;
  } catch (error) {
    if (Number(error?.status) === 401 && typeof refreshToken === "function") {
      const refreshed = await refreshToken();
      await dropboxUploadFile(refreshed, path, contents);
      return refreshed;
    }
    throw error;
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    const idx = (crc ^ byte) & 0xff;
    crc = CRC_TABLE[idx] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const second = date.getUTCSeconds();
  const dosTime = (hour << 11) | (minute << 5) | Math.floor(second / 2);
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

function zipTextCompressed(filename, content) {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const nameBytes = encoder.encode(filename);
  const compressed = deflateRawSync(data);
  const checksum = crc32(data);
  const { dosTime, dosDate } = toDosDateTime(new Date());

  const localHeader = Buffer.alloc(30 + nameBytes.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(dosTime, 10);
  localHeader.writeUInt16LE(dosDate, 12);
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28);
  Buffer.from(nameBytes).copy(localHeader, 30);

  const centralHeader = Buffer.alloc(46 + nameBytes.length);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(dosTime, 12);
  centralHeader.writeUInt16LE(dosDate, 14);
  centralHeader.writeUInt32LE(checksum, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(data.length, 24);
  centralHeader.writeUInt16LE(nameBytes.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);
  Buffer.from(nameBytes).copy(centralHeader, 46);

  const centralOffset = localHeader.length + compressed.length;
  const endHeader = Buffer.alloc(22);
  endHeader.writeUInt32LE(0x06054b50, 0);
  endHeader.writeUInt16LE(0, 4);
  endHeader.writeUInt16LE(0, 6);
  endHeader.writeUInt16LE(1, 8);
  endHeader.writeUInt16LE(1, 10);
  endHeader.writeUInt32LE(centralHeader.length, 12);
  endHeader.writeUInt32LE(centralOffset, 16);
  endHeader.writeUInt16LE(0, 20);

  return Buffer.concat([localHeader, compressed, centralHeader, endHeader]);
}

async function uploadDropboxArtifacts(
  connectorCode,
  logPayload,
  rawPayload,
) {
  const dropboxConfig = loadDropboxConfig();
  if (!dropboxConfig) {
    return;
  }

  try {
    let accessToken = await dropboxRefreshAccessToken(dropboxConfig);
    const refreshToken = () => dropboxRefreshAccessToken(dropboxConfig);
    let uploadedLogPath = null;
    let uploadedRawPath = null;

    if (logPayload) {
      const logPath = buildDropboxLogPath(connectorCode, new Date());
      const logBytes = new TextEncoder().encode(
        `${JSON.stringify(logPayload, null, 2)}\n`,
      );
      accessToken = await dropboxUploadFileWithRetry(
        accessToken,
        logPath,
        logBytes,
        refreshToken,
      );
      uploadedLogPath = logPath;
    }

    if (rawPayload) {
      const timestamp = new Date();
      const rawPath = buildDropboxRawPath(connectorCode, timestamp);
      const rawText = `${JSON.stringify(rawPayload)}\n`;
      const entryName = `uk_aq_raw_cloud_run_${
        normalizeConnectorPrefix(connectorCode)
      }_${formatCompactTimestamp(timestamp)}.json`;
      const rawBytes = zipTextCompressed(entryName, rawText);
      await dropboxUploadFileWithRetry(
        accessToken,
        rawPath,
        rawBytes,
        refreshToken,
      );
      uploadedRawPath = rawPath;
    }

    logSummary("dropbox_upload_success", {
      connector_code: connectorCode,
      uploaded_log_path: uploadedLogPath,
      uploaded_raw_path: uploadedRawPath,
    });
  } catch (error) {
    logSummary("dropbox_upload_warning", {
      connector_code: connectorCode,
      message: shortError(error),
    });
  }
}

async function runDirectIngest(connectorId, overwriteStationName, dropboxCapture) {
  const sourceUrl = `${SCOMM_BASE_URL}/airrohr/v1/filter/country=${encodeURIComponent(SCOMM_COUNTRY)}`;
  const sourceRows = await fetchJsonWithRetry(sourceUrl, SOURCE_FETCH_RETRIES);
  const filteredRows = sourceRows.filter((row) => stationInBboxOrMissingCoords(row));
  if (dropboxCapture) {
    dropboxCapture.raw = {
      connector_code: CONNECTOR_CODE,
      service_ref: SCOMM_SERVICE_REF,
      source_url: sourceUrl,
      fetched: sourceRows.length,
      filtered: filteredRows.length,
      records: filteredRows,
    };
  }

  if (!filteredRows.length) {
    return {
      run_status: "success",
      run_message: "No Sensor.Community rows matched ingest filters.",
      count: 0,
      stations_updated: 0,
      timeseries_updated: 0,
      observations_upserted: 0,
      series_polled: 0,
      last_observed_at: null,
      history_written: 0,
      history_receipts_upserted: 0,
      history_enqueued: 0,
    };
  }

  const phenomenonIds = await upsertPhenomena(connectorId);
  const stationsUpdated = await upsertStations(
    filteredRows,
    connectorId,
    SCOMM_SERVICE_REF,
    Boolean(overwriteStationName),
  );

  const { stationRefs, timeseriesRefs, observationsByTimeseries } =
    buildObservationMap(filteredRows);
  const stationIdMap = await fetchStationIds(
    connectorId,
    SCOMM_SERVICE_REF,
    stationRefs,
  );

  const timeseriesPayload = [];
  for (const [timeseriesRef, observation] of observationsByTimeseries.entries()) {
    const stationId = stationIdMap[observation.station_ref];
    if (!stationId) {
      continue;
    }

    const valueMeta = Object.values(VALUE_TYPE_MAP).find(
      (entry) => entry.pollutant === observation.pollutant,
    );

    timeseriesPayload.push({
      timeseries_ref: timeseriesRef,
      label: valueMeta
        ? `${observation.station_ref} ${valueMeta.label}`
        : observation.pollutant,
      uom: valueMeta ? valueMeta.uom : null,
      station_id: stationId,
      connector_id: connectorId,
      service_ref: String(SCOMM_SERVICE_REF),
      phenomenon_id: phenomenonIds[observation.pollutant] ?? null,
      last_value_at: observation.observed_at,
      last_value: observation.value,
    });
  }

  await upsertTimeseries(timeseriesPayload);
  const timeseriesIdMap = await fetchTimeseriesIds(
    connectorId,
    SCOMM_SERVICE_REF,
    timeseriesRefs,
  );

  const observationRows = [];
  const historyRows = [];
  let lastObservedMs = Number.NEGATIVE_INFINITY;
  let lastObservedAt = null;

  for (const [timeseriesRef, observation] of observationsByTimeseries.entries()) {
    const timeseriesId = timeseriesIdMap[timeseriesRef];
    if (!timeseriesId) {
      continue;
    }

    observationRows.push({
      connector_id: connectorId,
      timeseries_id: timeseriesId,
      observed_at: observation.observed_at,
      value: observation.value,
      status: null,
    });
    const historyRow = toHistoryObservationRow(
      observationRows[observationRows.length - 1],
      CONNECTOR_CODE,
      String(SCOMM_SERVICE_REF),
      timeseriesRef,
    );
    if (historyRow) {
      historyRows.push(historyRow);
    }

    if (observation.observed_ms > lastObservedMs) {
      lastObservedMs = observation.observed_ms;
      lastObservedAt = observation.observed_at;
    }
  }

  const [observationsUpserted, historyWriteStats] = await Promise.all([
    upsertObservations(observationRows),
    writeHistoryWithOutbox(historyRows),
  ]);

  return {
    run_status: "success",
    run_message: "Sensor.Community direct ingest completed via Cloud Run.",
    count: filteredRows.length,
    stations_updated: stationsUpdated,
    timeseries_updated: timeseriesPayload.length,
    observations_upserted: observationsUpserted,
    series_polled: timeseriesPayload.length,
    last_observed_at: lastObservedAt,
    history_written: historyWriteStats.written,
    history_receipts_upserted: historyWriteStats.receipts_upserted,
    history_enqueued: historyWriteStats.enqueued,
  };
}

function deriveRunSummary(ingestResponse) {
  const payload = toObject(ingestResponse.body);
  const rawRunStatus =
    toStringOrNull(payload?.run_status) ||
    (ingestResponse.ok ? "success" : "failed");
  const runStatus = rawRunStatus === "success" ? "succeeded" : rawRunStatus;

  let runMessage = toStringOrNull(payload?.run_message);
  if (!runMessage) {
    if (ingestResponse.ok) {
      runMessage = "ingest_sensorcommunity completed via google_cloud_run";
    } else {
      runMessage = `ingest_sensorcommunity failed with status ${ingestResponse.status}`;
    }
  }

  return {
    runStatus,
    runMessage,
    payload,
  };
}

async function updateConnectorRun(
  connectorId,
  runEndedAtIso,
  runStatus,
  runMessage,
  runStartedAtIso,
) {
  const payload = {
    last_run_end: runEndedAtIso,
    last_run_status: runStatus,
    last_run_message: runMessage,
  };
  if (runStatus === "succeeded" || runStatus === "success") {
    payload.last_polled_at = runStartedAtIso;
  }

  const response = await postgrestRequest("PATCH", "connectors", {
    query: { id: `eq.${connectorId}` },
    body: payload,
    prefer: "return=minimal",
  });
  if (!response.ok) {
    throw new Error(
      `Failed to update connector run (${response.status}): ${response.text}`,
    );
  }
}

async function insertRunRow(
  connectorId,
  runStartedAtIso,
  runEndedAtIso,
  runStatus,
  runMessage,
  ingestResponse,
  payload,
) {
  const stationsUpdated =
    toIntegerOrNull(payload?.stations_updated) ??
    toIntegerOrNull(payload?.stations) ??
    toIntegerOrNull(payload?.stations_processed);
  const observationsUpserted =
    toIntegerOrNull(payload?.observations_upserted) ??
    toIntegerOrNull(payload?.observations);
  const timeseriesUpdated =
    toIntegerOrNull(payload?.timeseries_updated) ??
    toIntegerOrNull(payload?.timeseries);
  const seriesPolled =
    toIntegerOrNull(payload?.series_polled) ??
    toIntegerOrNull(payload?.timeseries) ??
    toIntegerOrNull(payload?.timeseries_updated);

  const row = {
    connector_id: connectorId,
    connector_code: CONNECTOR_CODE,
    run_started_at: runStartedAtIso,
    run_ended_at: runEndedAtIso,
    run_status: runStatus,
    run_message: runMessage,
    last_observed_at:
      toStringOrNull(payload?.last_observed_at) ??
      toStringOrNull(payload?.last_observed),
    stations_updated: stationsUpdated,
    observations_upserted: observationsUpserted,
    timeseries_updated: timeseriesUpdated,
    series_polled: seriesPolled,
    response_status: ingestResponse.status,
  };

  const response = await postgrestRequest("POST", "uk_aq_ingest_runs", {
    body: row,
    prefer: "return=minimal",
  });
  if (!response.ok) {
    throw new Error(
      `Failed to insert uk_aq_ingest_runs row (${response.status}): ${response.text}`,
    );
  }
}

async function insertErrorLog(connectorId, ingestResponse) {
  const entry = {
    id: crypto.randomUUID(),
    source: "cloud_run",
    severity: "error",
    message: "ingest_sensorcommunity dispatch failed",
    stack: null,
    context: {
      connector_code: CONNECTOR_CODE,
      response_status: ingestResponse.status,
      response_body: ingestResponse.body,
    },
    connector_id: connectorId,
    station_id: null,
    timeseries_id: null,
    dropbox_path: null,
  };

  const response = await postgrestRequest("POST", "error_logs", {
    schema: UK_AQ_RAW_SCHEMA,
    body: entry,
    prefer: "return=minimal",
  });
  if (!response.ok) {
    throw new Error(
      `Failed to insert error_logs row (${response.status}): ${response.text}`,
    );
  }
}

function logSummary(message, details) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      connector_code: CONNECTOR_CODE,
      message,
      ...details,
    }),
  );
}

async function main() {
  const connector = await loadConnector();
  if (!connector) {
    logSummary("connector_missing", {});
    return;
  }

  const now = new Date();
  const dueCheck = evaluateDue(connector, now);
  if (!dueCheck.due) {
    logSummary("skip", {
      reason: dueCheck.reason,
      poll_enabled: connector.poll_enabled,
      scheduler_backend:
        connector.scheduler_backend || SCHEDULER_BACKEND_SUPABASE_FUNCTION,
      interval_minutes: dueCheck.intervalMinutes,
    });
    return;
  }

  const runStartedAtIso = now.toISOString();
  const claim = await claimConnector(runStartedAtIso);
  if (!claim || claim.claimed !== true) {
    logSummary("skip", {
      reason: "claim_not_acquired",
      claim,
    });
    return;
  }

  const connectorId = Number(claim.connector_id || connector.id);
  let ingestResponse;
  const dropboxCapture = {};
  try {
    const payload = await runDirectIngest(
      connectorId,
      connector.overwrite_station_name,
      dropboxCapture,
    );
    ingestResponse = {
      ok: true,
      status: 200,
      body: payload,
      raw: JSON.stringify(payload),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ingestResponse = {
      ok: false,
      status: 500,
      body: {
        error: "direct_ingest_failed",
        message,
      },
      raw: message,
    };
  }

  const runEndedAtIso = new Date().toISOString();
  const { runStatus, runMessage, payload } = deriveRunSummary(ingestResponse);
  const runFailed =
    !ingestResponse.ok || runStatus === "failed" || runStatus === "error";

  await updateConnectorRun(
    connectorId,
    runEndedAtIso,
    runStatus,
    runMessage,
    runStartedAtIso,
  );
  await insertRunRow(
    connectorId,
    runStartedAtIso,
    runEndedAtIso,
    runStatus,
    runMessage,
    ingestResponse,
    payload,
  );

  await uploadDropboxArtifacts(
    CONNECTOR_CODE,
    {
      connector_id: connectorId,
      connector_code: CONNECTOR_CODE,
      run_started_at: runStartedAtIso,
      run_ended_at: runEndedAtIso,
      run_status: runStatus,
      run_message: runMessage,
      response_status: ingestResponse.status,
      payload,
    },
    dropboxCapture.raw || null,
  );

  if (runFailed) {
    await insertErrorLog(connectorId, ingestResponse);
    throw new Error(
      `ingest_sensorcommunity failed (${ingestResponse.status}): ${
        ingestResponse.raw || runMessage
      }`,
    );
  }

  logSummary("success", {
    run_status: runStatus,
    response_status: ingestResponse.status,
    interval_minutes: dueCheck.intervalMinutes,
    observations_upserted: payload?.observations_upserted ?? null,
    history_written: payload?.history_written ?? null,
    history_receipts_upserted: payload?.history_receipts_upserted ?? null,
    history_enqueued: payload?.history_enqueued ?? null,
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logSummary("failure", { error: message });
  process.exitCode = 1;
});
