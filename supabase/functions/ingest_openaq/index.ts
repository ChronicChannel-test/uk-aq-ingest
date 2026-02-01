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

type DropboxConfig = {
  appKey: string;
  appSecret: string;
  refreshToken: string;
};

type DropboxDiagnostics = {
  enabled: boolean;
  reason: string | null;
  has_app_key: boolean;
  has_app_secret: boolean;
  has_refresh_token: boolean;
  supabase_url: string | null;
  raw_allowed_supabase_url: string | null;
  raw_allowed_match: boolean;
  dropbox_root: string | null;
};

type RawRecorder = {
  lines: string[];
  responseCount: number;
  recordEvent: (name: string, payload: Record<string, unknown>) => void;
  recordResponse: (
    path: string,
    params: Record<string, string | number>,
    statusCode: number,
    payload: unknown,
  ) => void;
};

type OpenAQLocation = {
  id?: number;
  name?: string | null;
  locality?: string | null;
  isMobile?: boolean | null;
  isMonitor?: boolean | null;
  coordinates?: { latitude?: number | null; longitude?: number | null } | null;
  country?: { code?: string | null; name?: string | null } | null;
  provider?: { name?: string | null } | null;
  owner?: { name?: string | null } | string | null;
  // OpenAQ uses "sensors"; we treat sensor.id as timeseries_ref internally.
  sensors?: Array<{
    id?: number;
    name?: string | null;
    parameter?: { name?: string | null; units?: string | null; displayName?: string | null } | null;
  }>;
};

type OpenAQLatestRecord = {
  datetime?: { utc?: string | null } | null;
  value?: number | null;
  // OpenAQ uses sensorsId; we treat it as timeseries_ref internally.
  sensorsId?: number | null;
  locationsId?: number | null;
  coordinates?: { latitude?: number | null; longitude?: number | null } | null;
};

type OpenAQStationCheckpoint = {
  station_id: number;
  next_due_at: string | null;
  last_observed_at: string | null;
  observ_interval_samples: number[] | null;
  ingest_lag_samples: number[] | null;
  last_polled_at: string | null;
};

type OpenAQTimeseriesCheckpoint = {
  station_id: number;
  timeseries_id: number;
  next_due_at: string | null;
  last_observed_at: string | null;
  ingest_lag_samples: number[] | null;
  last_polled_at: string | null;
};

type OpenAQHourlyRecord = {
  datetime?: { utc?: string | null } | null;
  value?: number | null;
  // OpenAQ uses sensorsId; we treat it as timeseries_ref internally.
  sensorsId?: number | null;
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
const DEFAULT_MAX_RUNTIME_SECONDS = 110;
const DEFAULT_RATE_LIMIT_RETRIES = 3;
const DEFAULT_TIERED_LIMIT = 56;
const DEFAULT_STALE_LIMIT = 4;
const DEFAULT_RATE_LIMIT_STOP_THRESHOLD = 5;
const PROVIDER_SHORTNAMES: Record<string, string> = {
  "London Air Quality Network": "LAQN",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")
  ?? Deno.env.get("SB_SUPABASE_URL")
  ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  ?? Deno.env.get("SB_SERVICE_ROLE_KEY")
  ?? "";
const UK_AQ_CORE_SCHEMA = Deno.env.get("UK_AQ_CORE_SCHEMA")
  ?? "uk_aq_core";
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
const OPENAQ_MAX_RUNTIME_SECONDS = Number(
  Deno.env.get("OPENAQ_MAX_RUNTIME_SECONDS") ?? DEFAULT_MAX_RUNTIME_SECONDS,
);
const OPENAQ_RATE_LIMIT_RETRIES = Number(
  Deno.env.get("OPENAQ_RATE_LIMIT_RETRIES") ?? DEFAULT_RATE_LIMIT_RETRIES,
);
const OPENAQ_TIERED_LIMIT = Number(
  Deno.env.get("OPENAQ_TIERED_LIMIT") ?? DEFAULT_TIERED_LIMIT,
);
const OPENAQ_STALE_LIMIT = Number(
  Deno.env.get("OPENAQ_STALE_LIMIT") ?? DEFAULT_STALE_LIMIT,
);
const OPENAQ_RATE_LIMIT_STOP_THRESHOLD = Number(
  Deno.env.get("OPENAQ_RATE_LIMIT_STOP_THRESHOLD") ?? DEFAULT_RATE_LIMIT_STOP_THRESHOLD,
);
const OPENAQ_INGEST_STATION_FETCH = ["1", "true", "yes"].includes(
  String(Deno.env.get("OPENAQ_INGEST_STATION_FETCH") ?? "").toLowerCase(),
);
const UK_AQ_DROPBOX_ROOT = normalizeDropboxPath(Deno.env.get("UK_AQ_DROPBOX_ROOT") ?? "");
const DROPBOX_APP_KEY = Deno.env.get("DROPBOX_APP_KEY") ?? "";
const DROPBOX_APP_SECRET = Deno.env.get("DROPBOX_APP_SECRET") ?? "";
const DROPBOX_REFRESH_TOKEN = Deno.env.get("DROPBOX_REFRESH_TOKEN") ?? "";
const DROPBOX_ALLOWED_SUPABASE_URL = Deno.env.get("OPENAQ_RAW_DROPBOX_ALLOWED_SUPABASE_URL")
  ?? Deno.env.get("UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL")
  ?? "";
const DROPBOX_LOG_FOLDER = "/connectors/openaq/log";
const DROPBOX_RAW_FOLDER = "/connectors/openaq/raw_data";
const DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const DROPBOX_UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload";

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
  if (schema) {
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

async function rpcRequest<T>(
  fn: string,
  args?: Record<string, unknown>,
): Promise<{ data: T | null; error: { message: string } | null }> {
  if (!REST_BASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { data: null, error: { message: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." } };
  }
  try {
    const url = new URL(`${REST_BASE_URL}/rpc/${fn}`);
    const headers = postgrestHeaders(undefined, "uk_aq_public");
    headers["Accept-Profile"] = "uk_aq_public";
    headers["Content-Profile"] = "uk_aq_public";
    const resp = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(args ?? {}),
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
  } catch (err) {
    return { data: null, error: { message: String(err) } };
  }
}

async function loadOpenaqStationRefs(
  batchLimit: number,
  staleLimit: number,
): Promise<Array<{ station_ref: string; station_id: number | null }>> {
  const { data, error } = await rpcRequest<
    Array<{ station_ref: string; station_id: number | null }>
  >(
    "uk_aq_rpc_openaq_select_station_refs",
    {
      batch_limit: batchLimit,
      stale_limit: staleLimit,
    },
  );
  if (error) {
    throw new Error(`OpenAQ station selection failed: ${error.message}`);
  }
  return (data ?? []).map((row) => ({
    station_ref: String(row.station_ref),
    station_id: row.station_id === null ? null : Number(row.station_id),
  }));
}

async function fetchOpenaqStationCheckpoints(
  stationIds: number[],
): Promise<Record<number, OpenAQStationCheckpoint>> {
  if (!stationIds.length) {
    return {};
  }
  const { data, error } = await rpcRequest<OpenAQStationCheckpoint[]>(
    "uk_aq_rpc_openaq_station_checkpoints_select",
    {
      station_ids: stationIds,
    },
  );
  if (error) {
    throw new Error(`OpenAQ checkpoints fetch failed: ${error.message}`);
  }
  const mapping: Record<number, OpenAQStationCheckpoint> = {};
  for (const row of data ?? []) {
    mapping[Number(row.station_id)] = row;
  }
  return mapping;
}

async function upsertOpenaqStationCheckpoints(
  rows: Array<Record<string, unknown>>,
): Promise<number> {
  if (!rows.length) {
    return 0;
  }
  const { data, error } = await rpcRequest<Array<{ rows_upserted: number }>>(
    "uk_aq_rpc_openaq_station_checkpoints_upsert",
    { rows },
  );
  if (error) {
    throw new Error(`OpenAQ checkpoints upsert failed: ${error.message}`);
  }
  return data && data[0] ? Number(data[0].rows_upserted) : 0;
}

async function fetchOpenaqTimeseriesCheckpoints(
  stationIds: number[],
): Promise<Record<number, OpenAQTimeseriesCheckpoint>> {
  if (!stationIds.length) {
    return {};
  }
  const { data, error } = await rpcRequest<OpenAQTimeseriesCheckpoint[]>(
    "uk_aq_rpc_openaq_timeseries_checkpoints_select",
    {
      station_ids: stationIds,
    },
  );
  if (error) {
    throw new Error(`OpenAQ timeseries checkpoints fetch failed: ${error.message}`);
  }
  const mapping: Record<number, OpenAQTimeseriesCheckpoint> = {};
  for (const row of data ?? []) {
    mapping[Number(row.timeseries_id)] = row;
  }
  return mapping;
}

async function fetchOpenaqTimeseriesRefsByStationIds(
  connectorId: string,
  serviceRef: string,
  stationIds: number[],
): Promise<Record<number, string[]>> {
  if (!stationIds.length) {
    return {};
  }
  const mapping: Record<number, string[]> = {};
  for (let idx = 0; idx < stationIds.length; idx += 200) {
    const chunk = stationIds.slice(idx, idx + 200);
    const { data, error } = await rpcRequest<
      Array<{ station_id: number; timeseries_ref: string }>
    >(
      "uk_aq_rpc_timeseries_refs_by_station_ids",
      {
        connector_id: Number(connectorId),
        service_ref: serviceRef,
        station_ids: chunk,
      },
    );
    if (error) {
      throw new Error(`OpenAQ timeseries refs fetch failed: ${error.message}`);
    }
    for (const row of data ?? []) {
      const stationId = Number(row.station_id);
      const ref = String(row.timeseries_ref);
      if (!mapping[stationId]) {
        mapping[stationId] = [ref];
      } else {
        mapping[stationId].push(ref);
      }
    }
  }
  return mapping;
}

async function upsertOpenaqTimeseriesCheckpoints(
  rows: Array<Record<string, unknown>>,
): Promise<number> {
  if (!rows.length) {
    return 0;
  }
  const { data, error } = await rpcRequest<Array<{ rows_upserted: number }>>(
    "uk_aq_rpc_openaq_timeseries_checkpoints_upsert",
    { rows },
  );
  if (error) {
    throw new Error(`OpenAQ timeseries checkpoints upsert failed: ${error.message}`);
  }
  return data && data[0] ? Number(data[0].rows_upserted) : 0;
}

function normalizeDropboxPath(raw: string): string {
  const cleaned = raw.trim();
  if (!cleaned) {
    return "";
  }
  const rooted = cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
  return rooted.replace(/\/$/, "");
}

function dropboxWithRoot(path: string): string {
  const cleaned = normalizeDropboxPath(path);
  if (!UK_AQ_DROPBOX_ROOT) {
    return cleaned;
  }
  if (!cleaned) {
    return UK_AQ_DROPBOX_ROOT;
  }
  if (cleaned === UK_AQ_DROPBOX_ROOT || cleaned.startsWith(`${UK_AQ_DROPBOX_ROOT}/`)) {
    return cleaned;
  }
  return `${UK_AQ_DROPBOX_ROOT}${cleaned}`;
}

function formatCompactTimestamp(timestamp: Date): string {
  return timestamp.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function formatDateYmd(timestamp: Date): string {
  return timestamp.toISOString().slice(0, 10);
}

function normalizeConnectorPrefix(connectorCode: string | null): string {
  const cleaned = (connectorCode ?? "").trim().toLowerCase();
  const normalized = cleaned.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "openaq";
}

function buildDropboxLogPath(connectorCode: string | null, timestamp: Date): string {
  const stamp = formatCompactTimestamp(timestamp);
  const dateFolder = formatDateYmd(timestamp);
  const prefix = normalizeConnectorPrefix(connectorCode);
  const base = dropboxWithRoot(DROPBOX_LOG_FOLDER);
  return `${base}/${dateFolder}/uk_aq_log_edge_${prefix}_${stamp}.log`;
}

function buildDropboxRawPath(connectorCode: string | null, timestamp: Date): string {
  const stamp = formatCompactTimestamp(timestamp);
  const dateFolder = formatDateYmd(timestamp);
  const prefix = normalizeConnectorPrefix(connectorCode);
  const base = dropboxWithRoot(DROPBOX_RAW_FOLDER);
  return `${base}/${dateFolder}/uk_aq_raw_edge_${prefix}_${stamp}.zip`;
}

function createRawRecorder(): RawRecorder {
  const lines: string[] = [];
  const write = (entry: Record<string, unknown>) => {
    lines.push(JSON.stringify(entry));
  };
  const recorder: RawRecorder = {
    lines,
    responseCount: 0,
    recordEvent: (name, payload) => {
      write({
        type: name,
        recorded_at: new Date().toISOString(),
        payload,
      });
    },
    recordResponse: (path, params, statusCode, payload) => {
      recorder.responseCount += 1;
      write({
        type: "response",
        fetched_at: new Date().toISOString(),
        path,
        params,
        status_code: statusCode,
        payload,
      });
    },
  };
  write({ type: "meta", created_at: new Date().toISOString() });
  return recorder;
}

function loadDropboxConfig(): DropboxConfig | null {
  if (!DROPBOX_APP_KEY || !DROPBOX_APP_SECRET || !DROPBOX_REFRESH_TOKEN) {
    return null;
  }
  if (!DROPBOX_ALLOWED_SUPABASE_URL || DROPBOX_ALLOWED_SUPABASE_URL !== SUPABASE_URL) {
    return null;
  }
  return {
    appKey: DROPBOX_APP_KEY,
    appSecret: DROPBOX_APP_SECRET,
    refreshToken: DROPBOX_REFRESH_TOKEN,
  };
}

function buildDropboxDiagnostics(): DropboxDiagnostics {
  const hasAppKey = Boolean(DROPBOX_APP_KEY);
  const hasAppSecret = Boolean(DROPBOX_APP_SECRET);
  const hasRefreshToken = Boolean(DROPBOX_REFRESH_TOKEN);
  const supabaseUrl = SUPABASE_URL || null;
  const rawAllowed = DROPBOX_ALLOWED_SUPABASE_URL || null;
  const rawAllowedMatch = Boolean(rawAllowed) && rawAllowed === SUPABASE_URL;

  let reason: string | null = null;
  if (!SUPABASE_URL) {
    reason = "missing_supabase_url";
  } else if (!hasAppKey || !hasAppSecret || !hasRefreshToken) {
    reason = "missing_dropbox_credentials";
  } else if (!rawAllowed) {
    reason = "missing_dropbox_allowed_supabase_url";
  } else if (!rawAllowedMatch) {
    reason = "dropbox_allowed_supabase_url_mismatch";
  }

  return {
    enabled: reason === null,
    reason,
    has_app_key: hasAppKey,
    has_app_secret: hasAppSecret,
    has_refresh_token: hasRefreshToken,
    supabase_url: supabaseUrl,
    raw_allowed_supabase_url: rawAllowed,
    raw_allowed_match: rawAllowedMatch,
    dropbox_root: UK_AQ_DROPBOX_ROOT || null,
  };
}

async function dropboxRefreshAccessToken(config: DropboxConfig): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: config.refreshToken,
    client_id: config.appKey,
    client_secret: config.appSecret,
  });
  const resp = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    throw new Error(`Dropbox token request failed (${resp.status})`);
  }
  const payload = await resp.json();
  const token = payload?.access_token;
  if (!token) {
    throw new Error("Dropbox token response missing access_token.");
  }
  return String(token);
}

async function dropboxUploadFile(
  accessToken: string,
  path: string,
  contents: Uint8Array | string,
): Promise<void> {
  const args = { path, mode: "add", autorename: true, mute: false };
  const resp = await fetch(DROPBOX_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Dropbox-API-Arg": JSON.stringify(args),
      "Content-Type": "application/octet-stream",
    },
    body: typeof contents === "string" ? new TextEncoder().encode(contents) : contents,
  });
  if (!resp.ok) {
    throw new Error(`Dropbox upload failed (${resp.status})`);
  }
}

async function dropboxUploadFileWithRetry(
  config: DropboxConfig,
  path: string,
  contents: Uint8Array | string,
): Promise<void> {
  let token = await dropboxRefreshAccessToken(config);
  try {
    await dropboxUploadFile(token, path, contents);
  } catch (err) {
    if (String(err).includes("401")) {
      token = await dropboxRefreshAccessToken(config);
      await dropboxUploadFile(token, path, contents);
      return;
    }
    throw err;
  }
}

async function logError(entry: ErrorLogEntry): Promise<void> {
  try {
    await rpcRequest<Array<{ id: string }>>("uk_aq_rpc_error_log_insert", {
      entry: {
        source: "ingest_openaq",
        severity: entry.severity,
        message: entry.message,
        context: entry.context ?? null,
        connector_id: entry.connector_id ?? null,
      },
    });
  } catch (_err) {
    // Best-effort logging; never throw from logError.
  }
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

function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendSample(values: number[] | null, value: number, maxSamples = 30): number[] {
  const cleaned = Array.isArray(values) ? values.filter((v) => Number.isFinite(v)) : [];
  const next = [...cleaned, value].slice(-maxSamples);
  return next;
}

function medianSeconds(values: number[] | null): number | null {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sorted = values
    .filter((v) => Number.isFinite(v))
    .map((v) => Math.max(0, Math.round(v)))
    .sort((a, b) => a - b);
  if (!sorted.length) {
    return null;
  }
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function minSeconds(values: number[] | null): number | null {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  let minValue = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      continue;
    }
    const rounded = Math.max(0, Math.round(value));
    if (rounded < minValue) {
      minValue = rounded;
    }
  }
  if (!Number.isFinite(minValue)) {
    return null;
  }
  return minValue;
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

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    const idx = (crc ^ byte) & 0xff;
    crc = CRC_TABLE[idx] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
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

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function zipTextCompressed(filename: string, content: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const nameBytes = encoder.encode(filename);
  const crc = crc32(data);
  const fileSize = data.length;
  const compressed = await deflateRaw(data);
  const compressedSize = compressed.length;
  const { dosTime, dosDate } = toDosDateTime(new Date());

  const header: number[] = [];
  const push16 = (value: number) => {
    header.push(value & 0xff, (value >>> 8) & 0xff);
  };
  const push32 = (value: number) => {
    header.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };

  // Local file header.
  push32(0x04034b50);
  push16(20);
  push16(0);
  push16(8);
  push16(dosTime);
  push16(dosDate);
  push32(crc);
  push32(compressedSize);
  push32(fileSize);
  push16(nameBytes.length);
  push16(0);

  const localHeader = new Uint8Array([...header, ...nameBytes]);
  const localOffset = 0;
  const centralOffset = localHeader.length + compressedSize;

  const central: number[] = [];
  const c16 = (value: number) => {
    central.push(value & 0xff, (value >>> 8) & 0xff);
  };
  const c32 = (value: number) => {
    central.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };

  // Central directory header.
  c32(0x02014b50);
  c16(20);
  c16(20);
  c16(0);
  c16(8);
  c16(dosTime);
  c16(dosDate);
  c32(crc);
  c32(compressedSize);
  c32(fileSize);
  c16(nameBytes.length);
  c16(0);
  c16(0);
  c16(0);
  c16(0);
  c32(0);
  c32(localOffset);

  const centralHeader = new Uint8Array([...central, ...nameBytes]);

  const end: number[] = [];
  const e16 = (value: number) => {
    end.push(value & 0xff, (value >>> 8) & 0xff);
  };
  const e32 = (value: number) => {
    end.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  e32(0x06054b50);
  e16(0);
  e16(0);
  e16(1);
  e16(1);
  e32(centralHeader.length);
  e32(centralOffset);
  e16(0);

  const endHeader = new Uint8Array(end);
  const output = new Uint8Array(
    localHeader.length + compressedSize + centralHeader.length + endHeader.length,
  );
  output.set(localHeader, 0);
  output.set(compressed, localHeader.length);
  output.set(centralHeader, localHeader.length + compressedSize);
  output.set(endHeader, localHeader.length + compressedSize + centralHeader.length);
  return output;
}

function parseRateLimitHeaders(headers: Headers): {
  limit: number | null;
  remaining: number | null;
  reset: number | null;
  used: number | null;
} {
  const toNumber = (value: string | null): number | null => {
    if (!value) {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    limit: toNumber(headers.get("x-ratelimit-limit")),
    remaining: toNumber(headers.get("x-ratelimit-remaining")),
    reset: toNumber(headers.get("x-ratelimit-reset")),
    used: toNumber(headers.get("x-ratelimit-used")),
  };
}

let rateLimitRemaining: number | null = null;
let rateLimitStop = false;
let rateLimitStopReason: string | null = null;
let rateLimitLimit: number | null = null;
let rateLimitFirstRemaining: number | null = null;

function rateLimitDelayMs(reset: number | null): number {
  if (!Number.isFinite(reset) || reset === null) {
    return 0;
  }
  if (reset > 1e12) {
    return Math.max(0, reset - Date.now());
  }
  if (reset > 1e9) {
    return Math.max(0, reset * 1000 - Date.now());
  }
  return Math.max(0, reset * 1000);
}

async function maybeSleepForRateLimit(
  headers: Headers,
  rawRecorder?: RawRecorder | null,
  status?: number,
): Promise<void> {
  const info = parseRateLimitHeaders(headers);
  if (info.remaining === null || info.reset === null) {
    return;
  }
  if (info.remaining <= 1) {
    const delayMs = rateLimitDelayMs(info.reset);
    if (rawRecorder) {
      rawRecorder.recordEvent("rate_limit", {
        status: status ?? null,
        remaining: info.remaining,
        limit: info.limit,
        used: info.used,
        reset: info.reset,
        sleep_ms: delayMs,
      });
    }
    await sleep(delayMs);
  }
}

async function openaqRequest(
  path: string,
  params?: Record<string, string | number>,
  rawRecorder?: RawRecorder | null,
): Promise<any> {
  const url = new URL(`${OPENAQ_BASE_URL}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const retries = Number.isFinite(OPENAQ_RATE_LIMIT_RETRIES)
    ? Math.max(1, OPENAQ_RATE_LIMIT_RETRIES)
    : DEFAULT_RATE_LIMIT_RETRIES;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const resp = await fetch(url.toString(), { headers: openaqHeaders() });
    const contentType = resp.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json") ? await resp.json() : await resp.text();
    const info = parseRateLimitHeaders(resp.headers);
    if (info.remaining !== null && Number.isFinite(info.remaining)) {
      rateLimitRemaining = info.remaining;
      if (rateLimitFirstRemaining === null) {
        rateLimitFirstRemaining = info.remaining;
      }
      if (info.limit !== null && Number.isFinite(info.limit)) {
        rateLimitLimit = info.limit;
      }
      if (info.remaining <= OPENAQ_RATE_LIMIT_STOP_THRESHOLD) {
        rateLimitStop = true;
        rateLimitStopReason = "remaining_low";
      }
    }
    if (rawRecorder) {
      rawRecorder.recordResponse(path, params ?? {}, resp.status, payload);
    }
    if (resp.status === 429) {
      const delayMs = rateLimitDelayMs(info.reset) || Math.min(60000, 1000 * attempt);
      rateLimitStop = true;
      rateLimitStopReason = "rate_limit_429";
      if (rawRecorder) {
        rawRecorder.recordEvent("rate_limit", {
          status: resp.status,
          remaining: info.remaining,
          limit: info.limit,
          used: info.used,
          reset: info.reset,
          sleep_ms: delayMs,
        });
      }
      await sleep(delayMs);
      continue;
    }
    if (!resp.ok) {
      const message = typeof payload === "string" ? payload : JSON.stringify(payload);
      throw new Error(`OpenAQ request failed (${resp.status}): ${message}`);
    }
    await maybeSleepForRateLimit(resp.headers, rawRecorder, resp.status);
    return payload;
  }
  throw new Error(`OpenAQ request failed (429): rate limit retries exceeded`);
}

async function listLocations(bbox: string, rawRecorder?: RawRecorder | null): Promise<OpenAQLocation[]> {
  const results: OpenAQLocation[] = [];
  const limit = Number.isFinite(OPENAQ_PAGE_LIMIT) && OPENAQ_PAGE_LIMIT > 0
    ? Math.min(OPENAQ_PAGE_LIMIT, 1000)
    : DEFAULT_PAGE_LIMIT;
  let page = 1;
  while (true) {
    if (rateLimitStop) {
      break;
    }
    const payload = await openaqRequest("locations", { bbox, limit, page }, rawRecorder);
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

async function listLatestForLocation(
  locationId: string,
  rawRecorder?: RawRecorder | null,
): Promise<OpenAQLatestRecord[]> {
  const payload = await openaqRequest(
    `locations/${locationId}/latest`,
    { limit: 1000 },
    rawRecorder,
  );
  return Array.isArray(payload?.results) ? payload.results as OpenAQLatestRecord[] : [];
}

async function listHourlyMeasurements(
  timeseriesRef: string,
  datetimeFrom: string | null,
  datetimeTo: string | null,
  rawRecorder?: RawRecorder | null,
): Promise<OpenAQHourlyRecord[]> {
  const results: OpenAQHourlyRecord[] = [];
  const limit = Number.isFinite(OPENAQ_PAGE_LIMIT) && OPENAQ_PAGE_LIMIT > 0
    ? Math.min(OPENAQ_PAGE_LIMIT, 1000)
    : DEFAULT_PAGE_LIMIT;
  let page = 1;
  while (true) {
    if (rateLimitStop) {
      break;
    }
    const params: Record<string, string | number> = { limit, page };
    if (datetimeFrom) {
      params.datetime_from = datetimeFrom;
    }
    if (datetimeTo) {
      params.datetime_to = datetimeTo;
    }
    const payload = await openaqRequest(
      `sensors/${timeseriesRef}/measurements/hourly`,
      params,
      rawRecorder,
    );
    const pageResults = Array.isArray(payload?.results)
      ? payload.results as OpenAQHourlyRecord[]
      : [];
    results.push(...pageResults);
    if (!pageResults.length || pageResults.length < limit) {
      break;
    }
    page += 1;
    if (Number.isFinite(OPENAQ_MAX_PAGES) && OPENAQ_MAX_PAGES > 0 && page > OPENAQ_MAX_PAGES) {
      break;
    }
  }
  return results;
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  shouldStop?: () => boolean,
): Promise<void> {
  const pool = new Set<Promise<void>>();
  const limit = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 1;
  for (const item of items) {
    if (shouldStop && shouldStop()) {
      break;
    }
    const task = worker(item);
    pool.add(task);
    task.finally(() => pool.delete(task));
    if (pool.size >= limit) {
      await Promise.race(pool);
    }
  }
  await Promise.all(pool);
}

function recordObservation(
  observationsByTimeseriesRef: Map<string, Map<string, number | null>>,
  latestByTimeseriesRef: Map<string, { observed_at: string; value: number | null }>,
  latestObservedByStationId: Map<number, string>,
  timeseriesRef: string,
  observedAt: string,
  value: number | null,
  stationId: number | null,
  nowMs: number,
  windowMs: number | null,
): void {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) {
    return;
  }
  if (windowMs && observedMs < nowMs - windowMs) {
    return;
  }
  let timeseriesObservations = observationsByTimeseriesRef.get(timeseriesRef);
  if (!timeseriesObservations) {
    timeseriesObservations = new Map();
    observationsByTimeseriesRef.set(timeseriesRef, timeseriesObservations);
  }
  if (!timeseriesObservations.has(observedAt)) {
    timeseriesObservations.set(observedAt, value);
  } else if (timeseriesObservations.get(observedAt) === null && value !== null) {
    timeseriesObservations.set(observedAt, value);
  }
  const existing = latestByTimeseriesRef.get(timeseriesRef);
  if (!existing || observedAt > existing.observed_at) {
    latestByTimeseriesRef.set(timeseriesRef, { observed_at: observedAt, value });
  }
  if (stationId !== null) {
    const current = latestObservedByStationId.get(stationId);
    if (!current || observedAt > current) {
      latestObservedByStationId.set(stationId, observedAt);
    }
  }
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

function resolveProviderName(location: OpenAQLocation): string | null {
  if (location?.provider?.name && String(location.provider.name).trim()) {
    const raw = String(location.provider.name).trim();
    return PROVIDER_SHORTNAMES[raw] ?? raw;
  }
  return null;
}

function resolveOwnerName(location: OpenAQLocation): string | null {
  const owner = location?.owner;
  if (typeof owner === "string") {
    const raw = owner.trim();
    return raw ? raw : null;
  }
  if (owner && typeof owner === "object" && "name" in owner) {
    const raw = String((owner as { name?: string | null }).name ?? "").trim();
    return raw ? raw : null;
  }
  return null;
}

function normalizeOwnerName(ownerName: string | null): string | null {
  if (!ownerName) {
    return null;
  }
  const trimmed = ownerName.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.toLowerCase().startsWith("unknown")) {
    return null;
  }
  return trimmed;
}

function buildStationName(
  rawName: string | null,
  providerName: string | null,
  ownerName: string | null,
): string | null {
  const baseName = rawName && providerName ? `${providerName} ${rawName}` : rawName;
  if (!baseName) {
    return baseName;
  }
  const providerToken = providerName ? providerName.trim().toLowerCase() : null;
  const ownerToken = ownerName ? ownerName.trim().toLowerCase() : null;
  if (ownerName && ownerToken && providerToken && ownerToken === providerToken) {
    return baseName;
  }
  if (ownerName) {
    return `${baseName} - ${ownerName}`;
  }
  return baseName;
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
  const { data, error } = await rpcRequest<ConnectorRow[]>("uk_aq_rpc_connector_select", {
    connector_code: connectorCode,
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
    const { data } = await rpcRequest<Array<{ station_ref: string; station_name: string | null }>>(
      "uk_aq_rpc_station_names",
      {
        connector_id: Number(connectorId),
        service_ref: serviceRef,
        station_refs: chunk,
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
    const { data } = await rpcRequest<Array<{ id: number; station_ref: string }>>(
      "uk_aq_rpc_station_ids",
      {
        connector_id: Number(connectorId),
        service_ref: serviceRef,
        station_refs: chunk,
      },
    );
    for (const row of data ?? []) {
      mapping[String(row.station_ref)] = Number(row.id);
    }
  }
  return mapping;
}

async function upsertStationMetadata(
  attributesByStation: Record<number, Record<string, unknown>>,
): Promise<number> {
  const stationIds = Object.keys(attributesByStation).map(Number);
  if (!stationIds.length) {
    return 0;
  }
  const rows = stationIds.map((stationId) => ({
    station_id: stationId,
    attributes: attributesByStation[stationId],
    updated_at: new Date().toISOString(),
  }));
  const { data, error } = await rpcRequest<Array<{ station_metadata_upserted: number }>>(
    "uk_aq_rpc_station_metadata_upsert",
    { rows },
  );
  if (error) {
    throw new Error(`Station metadata upsert failed: ${error.message}`);
  }
  return data?.[0]?.station_metadata_upserted ?? 0;
}

async function upsertStations(
  locations: OpenAQLocation[],
  connectorId: string,
  serviceRef: string,
  overwriteStationName: boolean,
): Promise<number> {
  const rowsByRef: Record<string, Record<string, unknown>> = {};
  const ownerByRef: Record<string, string> = {};
  for (const location of locations) {
    const stationRef = resolveLocationId(location);
    if (!stationRef) {
      continue;
    }
    const { longitude, latitude } = resolveCoordinates(location);
    const rawName = resolveLocationName(location);
    const providerName = resolveProviderName(location);
    const ownerName = normalizeOwnerName(resolveOwnerName(location));
    const stationName = buildStationName(rawName, providerName, ownerName);
    const row: Record<string, unknown> = {
      station_ref: stationRef,
      service_ref: String(serviceRef),
      label: rawName ?? `OpenAQ ${stationRef}`,
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
    if (ownerName) {
      ownerByRef[stationRef] = ownerName;
    }
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
  const { data, error } = await rpcRequest<Array<{ stations_upserted: number }>>(
    "uk_aq_rpc_stations_upsert",
    { rows },
  );
  if (error) {
    throw new Error(`Stations upsert failed: ${error.message}`);
  }
  if (Object.keys(ownerByRef).length) {
    const stationIds = await fetchStationIds(
      connectorId,
      serviceRef,
      Object.keys(ownerByRef),
    );
    const attributesByStation: Record<number, Record<string, unknown>> = {};
    for (const [stationRef, ownerName] of Object.entries(ownerByRef)) {
      const stationId = stationIds[stationRef];
      if (!stationId) {
        continue;
      }
      attributesByStation[stationId] = { openaq_owner: ownerName };
    }
    await upsertStationMetadata(attributesByStation);
  }
  return data?.[0]?.stations_upserted ?? 0;
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
    const { error } = await rpcRequest<Array<{ phenomena_upserted: number }>>(
      "uk_aq_rpc_phenomena_upsert",
      { rows: payload },
    );
    if (error) {
      throw new Error(`Phenomena upsert failed: ${error.message}`);
    }
  }
  const eionetUris = Object.values(parameters).map((meta) => `openaq:${meta.name}`);
  if (!eionetUris.length) {
    return {};
  }
  const { data } = await rpcRequest<Array<{ id: number; eionet_uri: string }>>(
    "uk_aq_rpc_phenomena_ids",
    {
      connector_id: Number(connectorId),
      eionet_uris: eionetUris,
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
  const { data, error } = await rpcRequest<Array<{ timeseries_upserted: number }>>(
    "uk_aq_rpc_timeseries_upsert",
    { rows },
  );
  if (error) {
    throw new Error(`Timeseries upsert failed: ${error.message}`);
  }
  return data?.[0]?.timeseries_upserted ?? 0;
}

async function updateTimeseriesLastValues(
  rows: Array<{ id: number; last_value: number; last_value_at: string }>,
  errors: string[],
): Promise<number> {
  if (!rows.length) {
    return 0;
  }
  const { data, error } = await rpcRequest<Array<{ timeseries_updated: number }>>(
    "uk_aq_rpc_timeseries_last_values_update",
    { rows },
  );
  if (error) {
    const message = `timeseries update failed: ${error.message}`;
    errors.push(message);
    console.warn(message);
    return 0;
  }
  return data?.[0]?.timeseries_updated ?? 0;
}

async function fetchTimeseriesIds(
  connectorId: string,
  serviceRef: string,
  timeseriesRefs: string[],
): Promise<Record<string, number>> {
  const mapping: Record<string, number> = {};
  for (let idx = 0; idx < timeseriesRefs.length; idx += 200) {
    const chunk = timeseriesRefs.slice(idx, idx + 200);
    const { data } = await rpcRequest<Array<{ id: number; timeseries_ref: string }>>(
      "uk_aq_rpc_timeseries_ids",
      {
        connector_id: Number(connectorId),
        service_ref: serviceRef,
        timeseries_refs: chunk,
      },
    );
    for (const row of data ?? []) {
      mapping[String(row.timeseries_ref)] = Number(row.id);
    }
  }
  return mapping;
}

async function fetchTimeseriesStationIds(
  timeseriesIds: number[],
): Promise<Record<number, number>> {
  const ids = timeseriesIds.filter((id) => Number.isFinite(id));
  if (!ids.length) {
    return {};
  }
  const mapping: Record<number, number> = {};
  for (let idx = 0; idx < ids.length; idx += 200) {
    const chunk = ids.slice(idx, idx + 200);
    const { data, error } = await postgrestRequest<
      Array<{ id: number; station_id: number | null }>
    >(
      "GET",
      "timeseries",
      {
        select: "id,station_id",
        id: postgrestIn(chunk.map((value) => String(value))),
      },
    );
    if (error) {
      throw new Error(`Failed to load timeseries station ids: ${error.message}`);
    }
    for (const row of data ?? []) {
      if (row.station_id) {
        mapping[Number(row.id)] = Number(row.station_id);
      }
    }
  }
  return mapping;
}

async function upsertObservations(rows: Array<Record<string, unknown>>): Promise<number> {
  if (!rows.length) {
    return 0;
  }
  const { data, error } = await rpcRequest<Array<{ observations_upserted: number }>>(
    "uk_aq_rpc_observations_upsert",
    { rows },
  );
  if (error) {
    throw new Error(`Observations upsert failed: ${error.message}`);
  }
  return data?.[0]?.observations_upserted ?? 0;
}

function collectParameters(locations: OpenAQLocation[]): Record<string, ParameterMeta> {
  const parameters: Record<string, ParameterMeta> = {};
  for (const location of locations) {
    for (const timeseries of location?.sensors ?? []) {
      const paramName = timeseries?.parameter?.name;
      if (!paramName || !String(paramName).trim()) {
        continue;
      }
      const name = String(paramName).trim();
      if (!parameters[name]) {
        parameters[name] = {
          name,
          displayName: timeseries?.parameter?.displayName
            ? String(timeseries.parameter.displayName)
            : null,
          units: timeseries?.parameter?.units
            ? String(timeseries.parameter.units)
            : null,
        };
      }
    }
  }
  return parameters;
}

function collectTimeseriesRefs(
  locations: OpenAQLocation[],
): Map<string, { locationId: string; parameter: ParameterMeta }> {
  const timeseriesRefs = new Map<string, { locationId: string; parameter: ParameterMeta }>();
  for (const location of locations) {
    const locationId = resolveLocationId(location);
    if (!locationId) {
      continue;
    }
    for (const timeseries of location?.sensors ?? []) {
      const timeseriesRef = timeseries?.id;
      const paramName = timeseries?.parameter?.name;
      if (!timeseriesRef || !paramName) {
        continue;
      }
      const name = String(paramName).trim();
      if (!name) {
        continue;
      }
      const parameter: ParameterMeta = {
        name,
        displayName: timeseries?.parameter?.displayName
          ? String(timeseries.parameter.displayName)
          : null,
        units: timeseries?.parameter?.units
          ? String(timeseries.parameter.units)
          : null,
      };
      timeseriesRefs.set(String(timeseriesRef), { locationId, parameter });
    }
  }
  return timeseriesRefs;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  rateLimitRemaining = null;
  rateLimitStop = false;
  rateLimitStopReason = null;
  rateLimitLimit = null;
  rateLimitFirstRemaining = null;
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
  const hasRequestedRefs = Array.isArray(payload.station_refs) && payload.station_refs.length > 0;
  let stationRefs = Array.isArray(payload.station_refs)
    ? payload.station_refs.map((ref) => String(ref))
    : [];
  let stationIdByRef: Record<string, number> = {};
  let selectedStations: Array<{ station_ref: string; station_id: number | null }> = [];
  const stationsRequested = hasRequestedRefs ? stationRefs.length : 0;
  const windowHours = Number(payload.window_hours ?? DEFAULT_WINDOW_HOURS);
  const dryRun = payload.dry_run ?? false;
  const runStartedAt = Date.now();
  const maxRuntimeSeconds = Number.isFinite(OPENAQ_MAX_RUNTIME_SECONDS)
    ? Math.max(30, OPENAQ_MAX_RUNTIME_SECONDS)
    : DEFAULT_MAX_RUNTIME_SECONDS;
  const runtimeDeadline = runStartedAt + maxRuntimeSeconds * 1000;
  const shouldStop = () => Date.now() >= runtimeDeadline || rateLimitStop;
  let timeBudgetHit = false;
  const logLines: string[] = [];
  const logLine = (level: string, message: string, context?: Record<string, unknown>) => {
    const stamp = new Date().toISOString();
    const ctx = context ? ` ${JSON.stringify(context)}` : "";
    logLines.push(`[${stamp}] ${level} ${message}${ctx}`);
  };
  const logTimeseriesRefMapping = (
    refs: string[],
    mapping: Record<string, number>,
    extra?: Record<string, unknown>,
  ) => {
    if (!refs.length) {
      return;
    }
    const uniqueRefs = Array.from(new Set(refs));
    const missingSample: string[] = [];
    let missingCount = 0;
    for (const ref of uniqueRefs) {
      if (mapping[ref] === undefined) {
        missingCount += 1;
        if (missingSample.length < 10) {
          missingSample.push(ref);
        }
      }
    }
    logLine("INFO", "OpenAQ timeseries ref mapping", {
      timeseries_refs_total: uniqueRefs.length,
      timeseries_ids_mapped: Object.keys(mapping).length,
      timeseries_refs_missing: missingCount,
      timeseries_refs_missing_sample: missingSample,
      ...extra,
    });
  };
  const logTimeseriesStationMapping = (
    refMapping: Record<string, number>,
    stationMapping: Record<number, number>,
    extra?: Record<string, unknown>,
  ) => {
    const entries = Object.entries(refMapping);
    if (!entries.length) {
      return;
    }
    const missingSample: Array<{ timeseries_ref: string; timeseries_id: number }> = [];
    let missingCount = 0;
    for (const [ref, id] of entries) {
      if (stationMapping[id] === undefined) {
        missingCount += 1;
        if (missingSample.length < 10) {
          missingSample.push({ timeseries_ref: ref, timeseries_id: id });
        }
      }
    }
    logLine("INFO", "OpenAQ timeseries station mapping", {
      timeseries_ids_total: entries.length,
      station_ids_mapped: Object.keys(stationMapping).length,
      station_ids_missing: missingCount,
      station_ids_missing_sample: missingSample,
      ...extra,
    });
  };
  const populateStationIdByTimeseriesIdFromRefs = (
    refMapping: Record<string, number>,
    stationMapping: Map<string, number>,
    target: Record<number, number>,
  ) => {
    for (const [timeseriesRef, timeseriesId] of Object.entries(refMapping)) {
      const stationId = stationMapping.get(timeseriesRef);
      if (stationId) {
        target[Number(timeseriesId)] = stationId;
      }
    }
  };
  const dropboxConfig = loadDropboxConfig();
  const dropboxDiagnostics = buildDropboxDiagnostics();
  const rawRecorder = dropboxConfig ? createRawRecorder() : null;
  logLine("INFO", "OpenAQ ingest started", {
    connector_code: connectorCode,
    window_hours: windowHours,
    dry_run: dryRun,
    station_refs: stationRefs.length ? stationRefs.length : 0,
    max_runtime_seconds: maxRuntimeSeconds,
  });

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
  rawRecorder?.recordEvent("context", {
    connector_code: connectorCode,
    bbox,
    window_hours: windowHours,
    dry_run: dryRun,
    station_refs: stationRefs,
  });

  if (!stationRefs.length) {
    try {
      selectedStations = await loadOpenaqStationRefs(OPENAQ_TIERED_LIMIT, OPENAQ_STALE_LIMIT);
      stationRefs = selectedStations.map((row) => row.station_ref);
      for (const row of selectedStations) {
        if (row.station_id !== null && Number.isFinite(row.station_id)) {
          stationIdByRef[row.station_ref] = row.station_id;
        }
      }
    } catch (err) {
      await logError({
        severity: "error",
        message: "OpenAQ station selection failed",
        connector_id: connector.id,
        context: { error: String(err) },
      });
      return jsonResponse({ error: String(err) }, 502);
    }
    rawRecorder?.recordEvent("selection", {
      tiered_limit: OPENAQ_TIERED_LIMIT,
      stale_limit: OPENAQ_STALE_LIMIT,
      station_refs: stationRefs,
    });
    if (!stationRefs.length) {
      logLine("INFO", "No OpenAQ station refs selected", {
        tiered_limit: OPENAQ_TIERED_LIMIT,
        stale_limit: OPENAQ_STALE_LIMIT,
      });
      return jsonResponse({ status: "no_station_refs_selected" }, 200);
    }
  }
  const stationsSelected = stationRefs.length;

  const locationsFetched = OPENAQ_INGEST_STATION_FETCH;
  let locations: OpenAQLocation[] = [];
  if (locationsFetched) {
    try {
      locations = await listLocations(bbox, rawRecorder);
    } catch (err) {
      await logError({
        severity: "error",
        message: "OpenAQ location fetch failed",
        connector_id: connector.id,
        context: { error: String(err) },
      });
      return jsonResponse({ error: String(err) }, 502);
    }
    logLine("INFO", "Fetched OpenAQ locations", { count: locations.length });
  }

  if (locationsFetched && stationRefs.length) {
    locations = locations.filter((loc) => {
      const locationId = resolveLocationId(loc);
      return locationId ? stationRefs.includes(locationId) : false;
    });
  }

  const connectorId = String(connector.id);
  const overwriteStationName = connector.overwrite_station_name ?? false;
  const stationsUpdated = locationsFetched && !dryRun
    ? await upsertStations(locations, connectorId, OPENAQ_SERVICE_REF, overwriteStationName)
    : locationsFetched && dryRun
    ? locations.length
    : 0;

  const stationRefsForIds = locationsFetched
    ? locations
      .map((location) => resolveLocationId(location))
      .filter((id): id is string => Boolean(id))
    : stationRefs;
  const missingRefsForIds = stationRefsForIds.filter(
    (ref) => stationIdByRef[ref] === undefined,
  );
  if (missingRefsForIds.length) {
    const fetchedIds = await fetchStationIds(
      connectorId,
      OPENAQ_SERVICE_REF,
      missingRefsForIds,
    );
    stationIdByRef = { ...stationIdByRef, ...fetchedIds };
  }
  {
    const missingStationRefs = stationRefsForIds.filter(
      (ref) => stationIdByRef[ref] === undefined,
    );
    logLine("INFO", "OpenAQ station ref mapping", {
      station_refs_total: stationRefsForIds.length,
      station_ids_mapped: Object.keys(stationIdByRef).length,
      station_refs_missing: missingStationRefs.length,
      station_refs_missing_sample: missingStationRefs.slice(0, 10),
      locations_fetched: locationsFetched,
    });
  }

  const stationIds = Object.values(stationIdByRef).map((id) => Number(id));
  let checkpointByStationId: Record<number, OpenAQStationCheckpoint> = {};
  try {
    checkpointByStationId = await fetchOpenaqStationCheckpoints(stationIds);
    logLine("INFO", "OpenAQ station checkpoints fetched", {
      station_ids: stationIds.length,
      checkpoints: Object.keys(checkpointByStationId).length,
    });
  } catch (err) {
    await logError({
      severity: "warn",
      message: "OpenAQ checkpoints fetch failed",
      connector_id: connector.id,
      context: { error: String(err) },
    });
    checkpointByStationId = {};
  }

  const nowMs = Date.now();
  const gapStationIds = new Set<number>();
  for (const stationId of stationIds) {
    const lastObservedAt = checkpointByStationId[stationId]?.last_observed_at ?? null;
    if (!lastObservedAt) {
      continue;
    }
    const lastObservedMs = Date.parse(lastObservedAt);
    if (!Number.isFinite(lastObservedMs)) {
      continue;
    }
    if (nowMs - lastObservedMs >= 2 * 60 * 60 * 1000) {
      gapStationIds.add(stationId);
    }
  }
  const debugStationId = 189841;
  if (Number.isFinite(stationIdByRef?.[debugStationId])) {
    logLine("INFO", "OpenAQ gap precheck debug", {
      station_id: debugStationId,
      last_observed_at: checkpointByStationId[debugStationId]?.last_observed_at ?? null,
      gap_flagged: gapStationIds.has(debugStationId),
    });
  }
  logLine("INFO", "OpenAQ gap precheck", {
    station_ids: stationIds.length,
    gap_station_ids: gapStationIds.size,
  });

  const parameters = locationsFetched ? collectParameters(locations) : {};
  const timeseriesRefMap = locationsFetched ? collectTimeseriesRefs(locations) : new Map();
  const phenomenonIds = locationsFetched ? await upsertPhenomena(connectorId, parameters) : {};

  const timeseriesRefsByStationId = new Map<number, string[]>();
  const stationIdByTimeseriesRef = new Map<string, number>();
  if (locationsFetched) {
    for (const [timeseriesRef, meta] of timeseriesRefMap.entries()) {
      const stationId = Number(stationIdByRef[meta.locationId]);
      if (!Number.isFinite(stationId)) {
        continue;
      }
      stationIdByTimeseriesRef.set(timeseriesRef, stationId);
      const existing = timeseriesRefsByStationId.get(stationId);
      if (existing) {
        existing.push(timeseriesRef);
      } else {
        timeseriesRefsByStationId.set(stationId, [timeseriesRef]);
      }
    }
    logLine("INFO", "OpenAQ timeseries mapping", {
      timeseries_total: timeseriesRefMap.size,
      station_ids_mapped: stationIdByTimeseriesRef.size,
      stations_with_timeseries: timeseriesRefsByStationId.size,
    });
  } else if (stationIds.length) {
    try {
      const refsByStation = await fetchOpenaqTimeseriesRefsByStationIds(
        connectorId,
        OPENAQ_SERVICE_REF,
        stationIds,
      );
      const perStationCounts: Record<string, number> = {};
      for (const [stationIdRaw, refs] of Object.entries(refsByStation)) {
        const stationId = Number(stationIdRaw);
        if (!Number.isFinite(stationId) || !refs.length) {
          continue;
        }
        const normalizedRefs = refs.map((ref) => String(ref));
        timeseriesRefsByStationId.set(stationId, normalizedRefs);
        for (const ref of normalizedRefs) {
          stationIdByTimeseriesRef.set(ref, stationId);
        }
        perStationCounts[stationIdRaw] = refs.length;
      }
      logLine("INFO", "OpenAQ timeseries refs loaded", {
        station_ids: stationIds.length,
        stations_with_timeseries: timeseriesRefsByStationId.size,
        timeseries_per_station_sample: Object.entries(perStationCounts)
          .slice(0, 10)
          .map(([station_id, count]) => ({ station_id: Number(station_id), count })),
      });
    } catch (err) {
      await logError({
        severity: "warn",
        message: "OpenAQ timeseries refs fetch failed",
        connector_id: connector.id,
        context: { error: String(err) },
      });
    }
  }

  const timeseriesRows: Array<Record<string, unknown>> = [];
  const timeseriesRefs: string[] = [];
  let timeseriesIdByRef: Record<string, number> = {};
  let stationIdByTimeseriesId: Record<number, number> = {};
  if (locationsFetched) {
    for (const [timeseriesRef, meta] of timeseriesRefMap.entries()) {
      const stationId = stationIdByRef[meta.locationId];
      if (!stationId) {
        continue;
      }
      const phenomenonId = phenomenonIds[meta.parameter.name];
      if (!phenomenonId) {
        continue;
      }
      const label = `${meta.locationId} ${meta.parameter.displayName ?? meta.parameter.name}`;
      timeseriesRows.push({
        timeseries_ref: timeseriesRef,
        label,
        uom: meta.parameter.units ?? null,
        station_id: stationId,
        connector_id: connectorId,
        service_ref: OPENAQ_SERVICE_REF,
        phenomenon_id: phenomenonId,
      });
      timeseriesRefs.push(timeseriesRef);
    }
    if (!dryRun) {
      await upsertTimeseries(timeseriesRows);
    }
    if (timeseriesRefs.length) {
      timeseriesIdByRef = await fetchTimeseriesIds(
        connectorId,
        OPENAQ_SERVICE_REF,
        timeseriesRefs,
      );
    }
    populateStationIdByTimeseriesIdFromRefs(
      timeseriesIdByRef,
      stationIdByTimeseriesRef,
      stationIdByTimeseriesId,
    );
    logTimeseriesRefMapping(timeseriesRefs, timeseriesIdByRef, {
      locations_fetched: locationsFetched,
      dry_run: dryRun,
    });
  }

  let timeseriesCheckpointById: Record<number, OpenAQTimeseriesCheckpoint> = {};
  if (stationIds.length) {
    try {
      timeseriesCheckpointById = await fetchOpenaqTimeseriesCheckpoints(stationIds);
      logLine("INFO", "OpenAQ timeseries checkpoints fetched", {
        station_ids: stationIds.length,
        checkpoints: Object.keys(timeseriesCheckpointById).length,
      });
    } catch (err) {
      await logError({
        severity: "warn",
        message: "OpenAQ timeseries checkpoints fetch failed",
        connector_id: connector.id,
        context: { error: String(err) },
      });
      timeseriesCheckpointById = {};
    }
  }

  const latestByTimeseries = new Map<string, { observed_at: string; value: number | null }>();
  const observationsByTimeseries = new Map<string, Map<string, number | null>>();
  const latestObservedByStationId = new Map<number, string>();
  const polledStationIds = new Set<number>();
  const windowMs = Number.isFinite(windowHours) && windowHours > 0
    ? windowHours * 60 * 60 * 1000
    : null;

  const locationIds = locationsFetched
    ? locations
      .map((location) => resolveLocationId(location))
      .filter((id): id is string => Boolean(id))
    : stationRefs;

  await runPool(locationIds, OPENAQ_CONCURRENCY, async (locationId) => {
    if (shouldStop()) {
      timeBudgetHit = true;
      return;
    }
    const stationIdValue = stationIdByRef[locationId];
    const stationId = stationIdValue ? Number(stationIdValue) : null;
    if (stationId !== null && Number.isFinite(stationId)) {
      polledStationIds.add(stationId);
    }

    if (stationId !== null && gapStationIds.has(stationId)) {
      const stationCheckpoint = checkpointByStationId[stationId];
      const timeseriesRefs = timeseriesRefsByStationId.get(stationId) ?? [];
      for (const timeseriesRef of timeseriesRefs) {
        if (shouldStop()) {
          timeBudgetHit = true;
          return;
        }
        const timeseriesId = timeseriesIdByRef[timeseriesRef];
        const tsCheckpoint = timeseriesId ? timeseriesCheckpointById[timeseriesId] : null;
        if (tsCheckpoint?.last_observed_at) {
          const tsObservedMs = Date.parse(tsCheckpoint.last_observed_at);
          if (Number.isFinite(tsObservedMs) && nowMs - tsObservedMs < 60 * 60 * 1000) {
            continue;
          }
        }
        const baseObservedAt = tsCheckpoint?.last_observed_at ?? stationCheckpoint?.last_observed_at
          ?? null;
        const datetimeFrom = baseObservedAt
          ?? (windowMs ? new Date(nowMs - windowMs).toISOString() : null);
        const datetimeTo = new Date(nowMs).toISOString();
        let hourly: OpenAQHourlyRecord[] = [];
        try {
          hourly = await listHourlyMeasurements(timeseriesRef, datetimeFrom, datetimeTo, rawRecorder);
        } catch (err) {
          await logError({
            severity: "warn",
            message: "OpenAQ hourly measurements fetch failed",
            connector_id: connector.id,
            context: { timeseries_ref: timeseriesRef, error: String(err) },
          });
          continue;
        }
        if (datetimeFrom && datetimeTo) {
          const start = new Date(datetimeFrom);
          const end = new Date(datetimeTo);
          if (Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && start < end) {
            start.setUTCMinutes(0, 0, 0);
            end.setUTCMinutes(0, 0, 0);
            const expected: string[] = [];
            const cursor = new Date(start);
            while (cursor < end) {
              expected.push(cursor.toISOString());
              cursor.setUTCHours(cursor.getUTCHours() + 1);
            }
            const returned = new Set<string>();
            for (const record of hourly) {
              const observedAt = record?.datetime?.utc ?? record?.period?.datetimeFrom?.utc ?? null;
              if (!observedAt) {
                continue;
              }
              const observed = new Date(observedAt);
              if (!Number.isFinite(observed.getTime())) {
                continue;
              }
              observed.setUTCMinutes(0, 0, 0);
              returned.add(observed.toISOString());
            }
            const missing = expected.filter((hour) => !returned.has(hour));
            if (missing.length > 0) {
              logLine("INFO", "OpenAQ hourly gap detected", {
                station_id: stationId,
                timeseries_ref: timeseriesRef,
                datetime_from: datetimeFrom,
                datetime_to: datetimeTo,
                expected_hours: expected.length,
                returned_hours: returned.size,
                missing_hours: missing.slice(0, 12),
                missing_hours_count: missing.length,
              });
            }
          }
        }
        for (const record of hourly) {
          const observedAt = record?.datetime?.utc ?? record?.period?.datetimeFrom?.utc ?? null;
          if (!observedAt) {
            continue;
          }
        recordObservation(
          observationsByTimeseries,
          latestByTimeseries,
          latestObservedByStationId,
          String(record?.sensorsId ?? timeseriesRef),
          observedAt,
          record?.value ?? null,
          stationId,
            nowMs,
            windowMs,
          );
        }
      }
      return;
    }

    let latest: OpenAQLatestRecord[] = [];
    try {
      latest = await listLatestForLocation(locationId, rawRecorder);
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
      const timeseriesRef = record?.sensorsId;
      const observedAt = record?.datetime?.utc;
      if (!timeseriesRef || !observedAt) {
        continue;
      }
      recordObservation(
        observationsByTimeseries,
        latestByTimeseries,
        latestObservedByStationId,
        String(timeseriesRef),
        observedAt,
        record?.value ?? null,
        stationId,
        nowMs,
        windowMs,
      );
    }
  }, () => {
    if (shouldStop()) {
      timeBudgetHit = true;
      return true;
    }
    return false;
  });

  if (!locationsFetched) {
    for (const timeseriesRef of observationsByTimeseries.keys()) {
      timeseriesRefs.push(timeseriesRef);
    }
    if (!dryRun && timeseriesRefs.length) {
      timeseriesIdByRef = await fetchTimeseriesIds(
        connectorId,
        OPENAQ_SERVICE_REF,
        timeseriesRefs,
      );
    }
    populateStationIdByTimeseriesIdFromRefs(
      timeseriesIdByRef,
      stationIdByTimeseriesRef,
      stationIdByTimeseriesId,
    );
    logTimeseriesRefMapping(timeseriesRefs, timeseriesIdByRef, {
      locations_fetched: locationsFetched,
      dry_run: dryRun,
    });
  }
  if (!locationsFetched && Object.keys(timeseriesIdByRef).length) {
    try {
      stationIdByTimeseriesId = await fetchTimeseriesStationIds(
        Object.values(timeseriesIdByRef),
      );
      logTimeseriesStationMapping(timeseriesIdByRef, stationIdByTimeseriesId, {
        locations_fetched: locationsFetched,
      });
    } catch (err) {
      await logError({
        severity: "warn",
        message: "OpenAQ timeseries station lookup failed",
        connector_id: connector.id,
        context: { error: String(err) },
      });
      stationIdByTimeseriesId = {};
    }
  }

  logLine("INFO", "OpenAQ polling summary", {
    stations_selected: stationsSelected,
    stations_polled: polledStationIds.size,
    latest_timeseries: latestByTimeseries.size,
    observations_timeseries: observationsByTimeseries.size,
    timeseries_refs: timeseriesRefs.length,
    timeseries_ids: Object.keys(timeseriesIdByRef).length,
    timeseries_station_ids: Object.keys(stationIdByTimeseriesId).length,
  });

  let observationsUpserted = 0;
  let seriesPolled = observationsByTimeseries.size;
  let lastObservedAt: string | null = null;
  let timeseriesLastUpdated = 0;
  const timeseriesErrors: string[] = [];

  if (!dryRun) {
    const observationRows: Array<Record<string, unknown>> = [];
    for (const [timeseriesRef, observations] of observationsByTimeseries.entries()) {
      const timeseriesId = timeseriesIdByRef[timeseriesRef];
      if (!timeseriesId) {
        continue;
      }
      for (const [observedAt, value] of observations.entries()) {
        observationRows.push({
          connector_id: connectorId,
          timeseries_id: timeseriesId,
          observed_at: observedAt,
          value,
          status: null,
        });
      }
    }

    observationsUpserted = await upsertObservations(observationRows);
    const timeseriesUpdates: Array<{ id: number; last_value: number; last_value_at: string }> = [];
    for (const [timeseriesRef, latest] of latestByTimeseries.entries()) {
      const timeseriesId = timeseriesIdByRef[timeseriesRef];
      if (!timeseriesId) {
        continue;
      }
      if (typeof latest.value !== "number") {
        continue;
      }
      timeseriesUpdates.push({
        id: timeseriesId,
        last_value: latest.value,
        last_value_at: latest.observed_at,
      });
    }
    timeseriesLastUpdated = await updateTimeseriesLastValues(timeseriesUpdates, timeseriesErrors);
  }

  for (const latest of latestByTimeseries.values()) {
    if (!lastObservedAt || latest.observed_at > lastObservedAt) {
      lastObservedAt = latest.observed_at;
    }
  }

  if (timeseriesErrors.length) {
    await logError({
      severity: "warn",
      message: "Timeseries last_value updates failed",
      connector_id: connector.id,
      context: { errors: timeseriesErrors.slice(0, 10) },
    });
  }

  if (!dryRun && polledStationIds.size) {
    const checkpointRows: Array<Record<string, unknown>> = [];
    const nowIso = new Date().toISOString();
    const nowMsForLag = Date.now();
    const stationObservedSample: Array<{
      station_id: number;
      min_observed_at: string | null;
      latest_observed_at: string | null;
    }> = [];
    const resolveStationMinObservedAt = (stationId: number): string | null => {
      const timeseriesRefs = timeseriesRefsByStationId.get(stationId);
      if (!timeseriesRefs?.length) {
        return null;
      }
      let minObserved: string | null = null;
      for (const timeseriesRef of timeseriesRefs) {
        const latestObserved = latestByTimeseries.get(timeseriesRef)?.observed_at ?? null;
        const timeseriesId = timeseriesIdByRef[timeseriesRef];
        const checkpointObserved = timeseriesId
          ? timeseriesCheckpointById[timeseriesId]?.last_observed_at ?? null
          : null;
        const candidate = latestObserved ?? checkpointObserved;
        if (!candidate) {
          continue;
        }
        if (!minObserved || candidate < minObserved) {
          minObserved = candidate;
        }
      }
      return minObserved;
    };
    for (const stationId of polledStationIds) {
      const checkpoint = checkpointByStationId[stationId];
      const isNewCheckpoint = checkpoint === undefined;
      const previousLastObserved = checkpoint?.last_observed_at ?? null;
      const previousNextDue = checkpoint?.next_due_at ?? null;
      let observSamples = checkpoint?.observ_interval_samples ?? [];
      let lagSamples = checkpoint?.ingest_lag_samples ?? [];
      let updatedLastObserved = previousLastObserved;
      let nextDueAt = previousNextDue;
      const latestObservedForScheduling = latestObservedByStationId.get(stationId) ?? null;
      const minObservedForStation = resolveStationMinObservedAt(stationId);

      if (minObservedForStation) {
        updatedLastObserved = minObservedForStation;
      }
      if (stationObservedSample.length < 10 && (minObservedForStation || latestObservedForScheduling)) {
        stationObservedSample.push({
          station_id: stationId,
          min_observed_at: minObservedForStation,
          latest_observed_at: latestObservedForScheduling,
        });
      }

      if (
        latestObservedForScheduling
        && (!previousLastObserved || latestObservedForScheduling > previousLastObserved)
      ) {
        let intervalSampleAdded = false;
        if (previousLastObserved) {
          const intervalSeconds = Math.max(
            0,
            Math.round(
              (Date.parse(latestObservedForScheduling) - Date.parse(previousLastObserved)) / 1000,
            ),
          );
          if (Number.isFinite(intervalSeconds) && intervalSeconds > 0) {
            observSamples = appendSample(observSamples, intervalSeconds);
            intervalSampleAdded = true;
          }
        }
        if (intervalSampleAdded) {
          const lagSeconds = Math.max(
            0,
            Math.round((nowMsForLag - Date.parse(latestObservedForScheduling)) / 1000),
          );
          if (Number.isFinite(lagSeconds)) {
            lagSamples = appendSample(lagSamples, lagSeconds);
          }
        }
        if (observSamples.length < 10 || lagSamples.length < 10) {
          nextDueAt = new Date(nowMsForLag + 5 * 60 * 1000).toISOString();
        } else {
          const intervalSeconds = Math.min(minSeconds(observSamples) ?? 5 * 60, 60 * 60);
          const lagSeconds = minSeconds(lagSamples) ?? 5 * 60;
          const baseMs = Date.parse(latestObservedForScheduling);
          if (Number.isFinite(baseMs)) {
            nextDueAt = new Date(baseMs + (intervalSeconds + lagSeconds) * 1000).toISOString();
          } else {
            nextDueAt = nowIso;
          }
        }
      } else if (!previousNextDue) {
        nextDueAt = new Date(nowMsForLag + 5 * 60 * 1000).toISOString();
      }

      checkpointRows.push({
        station_id: stationId,
        next_due_at: nextDueAt,
        last_observed_at: updatedLastObserved,
        observ_interval_samples: observSamples,
        ingest_lag_samples: lagSamples,
        last_polled_at: nowIso,
      });
    }

    try {
      const rowsUpserted = await upsertOpenaqStationCheckpoints(checkpointRows);
      logLine("INFO", "OpenAQ station checkpoints upserted", {
        rows_prepared: checkpointRows.length,
        rows_upserted: rowsUpserted,
        station_observed_sample: stationObservedSample,
      });
    } catch (err) {
      await logError({
        severity: "warn",
        message: "OpenAQ checkpoints upsert failed",
        connector_id: connector.id,
        context: { error: String(err) },
      });
    }

    if (latestByTimeseries.size) {
      const timeseriesCheckpointRows: Array<Record<string, unknown>> = [];
      const timeseriesCheckpointStats = {
        latest_timeseries: latestByTimeseries.size,
        rows_prepared: 0,
        skipped_missing_timeseries_id: 0,
        skipped_missing_station_id: 0,
        missing_timeseries_id_sample: [] as string[],
        missing_station_id_sample: [] as Array<{ timeseries_ref: string; timeseries_id: number }>,
        new_checkpoints: 0,
        existing_checkpoints: 0,
        new_observations: 0,
        next_due_updated: 0,
      };
      for (const [timeseriesRef, latest] of latestByTimeseries.entries()) {
        const timeseriesId = timeseriesIdByRef[timeseriesRef];
        if (!timeseriesId) {
          timeseriesCheckpointStats.skipped_missing_timeseries_id += 1;
          if (timeseriesCheckpointStats.missing_timeseries_id_sample.length < 10) {
            timeseriesCheckpointStats.missing_timeseries_id_sample.push(timeseriesRef);
          }
          continue;
        }
        const stationId = stationIdByTimeseriesRef.get(timeseriesRef)
          ?? stationIdByTimeseriesId[timeseriesId];
        if (!stationId) {
          timeseriesCheckpointStats.skipped_missing_station_id += 1;
          if (timeseriesCheckpointStats.missing_station_id_sample.length < 10) {
            timeseriesCheckpointStats.missing_station_id_sample.push({
              timeseries_ref: timeseriesRef,
              timeseries_id: timeseriesId,
            });
          }
          continue;
        }
        const checkpoint = timeseriesCheckpointById[timeseriesId];
        if (checkpoint) {
          timeseriesCheckpointStats.existing_checkpoints += 1;
        } else {
          timeseriesCheckpointStats.new_checkpoints += 1;
        }
        const previousLastObserved = checkpoint?.last_observed_at ?? null;
        const previousNextDue = checkpoint?.next_due_at ?? null;
        let lagSamples = checkpoint?.ingest_lag_samples ?? [];
        let updatedLastObserved = previousLastObserved;
        let nextDueAt = previousNextDue;
        const latestObserved = latest?.observed_at ?? null;
        let hasNewObservation = false;

        if (latestObserved && (!previousLastObserved || latestObserved > previousLastObserved)) {
          updatedLastObserved = latestObserved;
          hasNewObservation = true;
          timeseriesCheckpointStats.new_observations += 1;
          const lagSeconds = Math.max(
            0,
            Math.round((nowMsForLag - Date.parse(latestObserved)) / 1000),
          );
          if (Number.isFinite(lagSeconds)) {
            lagSamples = appendSample(lagSamples, lagSeconds);
          }
        }

        if (hasNewObservation || !previousNextDue) {
          timeseriesCheckpointStats.next_due_updated += 1;
          if (lagSamples.length < 10) {
            nextDueAt = new Date(nowMsForLag + 5 * 60 * 1000).toISOString();
          } else {
            const lagSeconds = minSeconds(lagSamples) ?? 5 * 60;
            const baseMs = Date.parse(updatedLastObserved ?? latestObserved ?? "");
            if (Number.isFinite(baseMs)) {
              nextDueAt = new Date(baseMs + (60 * 60 + lagSeconds) * 1000).toISOString();
            } else {
              nextDueAt = nowIso;
            }
          }
        }

        timeseriesCheckpointRows.push({
          station_id: stationId,
          timeseries_id: timeseriesId,
          next_due_at: nextDueAt,
          last_observed_at: updatedLastObserved,
          ingest_lag_samples: lagSamples,
          last_polled_at: nowIso,
        });
        timeseriesCheckpointStats.rows_prepared += 1;
      }

      if (timeseriesCheckpointRows.length) {
        try {
          const rowsUpserted = await upsertOpenaqTimeseriesCheckpoints(timeseriesCheckpointRows);
          logLine("INFO", "OpenAQ timeseries checkpoints upserted", {
            ...timeseriesCheckpointStats,
            rows_upserted: rowsUpserted,
          });
        } catch (err) {
          await logError({
            severity: "warn",
            message: "OpenAQ timeseries checkpoints upsert failed",
            connector_id: connector.id,
            context: { error: String(err) },
          });
        }
      } else {
        logLine("INFO", "OpenAQ timeseries checkpoints skipped (no rows)", {
          ...timeseriesCheckpointStats,
        });
      }
    }
  } else if (!dryRun) {
    logLine("INFO", "OpenAQ checkpoint updates skipped", {
      stations_polled: polledStationIds.size,
      latest_timeseries: latestByTimeseries.size,
      dry_run: dryRun,
    });
  }

  const stoppedReason = timeBudgetHit
    ? "runtime_budget_exceeded"
    : rateLimitStop
    ? (rateLimitStopReason ?? "rate_limit_guard")
    : null;
  const rateLimitUsedEstimate = rateLimitLimit !== null && rateLimitRemaining !== null
    ? Math.max(0, rateLimitLimit - rateLimitRemaining)
    : null;

  logLine("INFO", "OpenAQ ingest complete", {
    locations: locations.length,
    station_fetch_enabled: locationsFetched,
    stations_selected: stationsSelected,
    stations_polled: polledStationIds.size,
    stations_updated: stationsUpdated,
    timeseries_updated: timeseriesRows.length,
    timeseries_last_updated: timeseriesLastUpdated,
    observations_upserted: observationsUpserted,
    series_polled: seriesPolled,
    last_observed_at: lastObservedAt,
    rate_limit_remaining: rateLimitRemaining,
    rate_limit_stop: rateLimitStop,
    rate_limit_stop_reason: rateLimitStopReason,
    partial: timeBudgetHit,
    stopped_reason: stoppedReason,
    raw_responses: rawRecorder?.responseCount ?? 0,
  });

  logLine("INFO", "OpenAQ rate limit summary", {
    rate_limit_limit: rateLimitLimit,
    rate_limit_remaining_first: rateLimitFirstRemaining,
    rate_limit_remaining_last: rateLimitRemaining,
    rate_limit_used_estimate: rateLimitUsedEstimate,
    requests_total: rawRecorder?.responseCount ?? 0,
    stations_selected: stationsSelected,
    stations_polled: polledStationIds.size,
    stopped_reason: stoppedReason,
  });

  if (dropboxConfig) {
    try {
      if (rawRecorder) {
        const rawPayload = rawRecorder.lines.join("\n") + "\n";
        const jsonlName = buildDropboxRawPath(connectorCode, new Date()).replace(/\.zip$/i, ".jsonl");
        const zipped = await zipTextCompressed(jsonlName.split("/").slice(-1)[0], rawPayload);
        await dropboxUploadFileWithRetry(
          dropboxConfig,
          buildDropboxRawPath(connectorCode, new Date()),
          zipped,
        );
      }
      await dropboxUploadFileWithRetry(
        dropboxConfig,
        buildDropboxLogPath(connectorCode, new Date()),
        logLines.join("\n") + "\n",
      );
    } catch (err) {
      await logError({
        severity: "warn",
        message: "Dropbox log/raw upload failed.",
        connector_id: connector.id,
        context: { error: String(err), dropbox: dropboxDiagnostics },
      });
    }
  } else if (dropboxDiagnostics.reason) {
    await logError({
      severity: "warn",
      message: "Dropbox log/raw uploads disabled.",
      connector_id: connector.id,
      context: { dropbox: dropboxDiagnostics },
    });
  }

  return jsonResponse({
    connector_code: connectorCode,
    stations_requested: stationsRequested,
    stations_selected: stationsSelected,
    stations_polled: polledStationIds.size,
    stations_updated: stationsUpdated,
    timeseries_updated: timeseriesRows.length,
    observations_upserted: observationsUpserted,
    series_polled: seriesPolled,
    window_hours: windowHours,
    last_observed_at: lastObservedAt,
    station_fetch_enabled: locationsFetched,
    partial: timeBudgetHit,
    stopped_reason: stoppedReason,
    rate_limit_remaining: rateLimitRemaining,
    rate_limit_limit: rateLimitLimit,
    rate_limit_remaining_first: rateLimitFirstRemaining,
    rate_limit_stop: rateLimitStop,
    rate_limit_stop_reason: rateLimitStopReason,
    rate_limit_used_estimate: rateLimitUsedEstimate,
    requests_total: rawRecorder?.responseCount ?? 0,
    dry_run: dryRun,
  });
});
