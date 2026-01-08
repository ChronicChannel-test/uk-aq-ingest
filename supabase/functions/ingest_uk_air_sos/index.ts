// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type PollRequest = {
  service_id?: string;
  service_label?: string;
  window_hours?: number;
  pollutants?: string[] | string;
  timeseries_ids?: string[] | string;
  timeseries_limit?: number;
};

type ServiceRow = {
  id: string;
  service_ref: string;
  label: string;
  service_url: string | null;
  poll_enabled: boolean | null;
  poll_window_hours: number | null;
  poll_timeseries_batch_size: number | null;
};

type DropboxConfig = {
  appKey: string;
  appSecret: string;
  refreshToken: string;
};

type ErrorLogEntry = {
  source: string;
  severity: string;
  message: string;
  stack?: string | null;
  context?: Record<string, unknown> | null;
  service_id?: string | number | null;
  station_id?: string | number | null;
  timeseries_id?: string | number | null;
};

const DEFAULT_BASE_URL = "https://uk-air.defra.gov.uk/sos-ukair/api/v1";
const DEFAULT_SERVICE_LABEL = "UK-AIR-SOS";
const DEFAULT_WINDOW_HOURS = 6;
const DEFAULT_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 1000;
const CONCURRENCY_LIMIT = 5;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")
  ?? Deno.env.get("SB_SUPABASE_URL")
  ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  ?? Deno.env.get("SB_SERVICE_ROLE_KEY")
  ?? "";
const UK_AIR_SOS_BASE_URL = (Deno.env.get("UK_AIR_SOS_BASE_URL")
  ?? Deno.env.get("UK_AIR_BASE_URL")
  ?? DEFAULT_BASE_URL).replace(/\/$/, "");
const UK_AIR_SOS_SERVICE_LABEL = Deno.env.get("UK_AIR_SOS_SERVICE_LABEL")
  ?? Deno.env.get("UK_AIR_SERVICE_LABEL")
  ?? DEFAULT_SERVICE_LABEL;
const DROPBOX_APP_KEY = Deno.env.get("DROPBOX_APP_KEY") ?? "";
const DROPBOX_APP_SECRET = Deno.env.get("DROPBOX_APP_SECRET") ?? "";
const DROPBOX_REFRESH_TOKEN = Deno.env.get("DROPBOX_REFRESH_TOKEN") ?? "";
const DROPBOX_ALLOWED_SUPABASE_URL = Deno.env.get("UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL") ?? "";
const DROPBOX_ERROR_ALLOWED_SUPABASE_URL =
  Deno.env.get("UK_AIR_ERROR_DROPBOX_ALLOWED_SUPABASE_URL") ?? "";
const DROPBOX_ROOT_FOLDER = (() => {
  const raw = Deno.env.get("UK_AIR_DROPBOX_ROOT") ?? "";
  return normalizeDropboxPath(raw);
})();

const DROPBOX_LOG_FOLDER = dropboxWithRoot("/log");
const DROPBOX_RAW_FOLDER = dropboxWithRoot("/raw_data");
const DROPBOX_ERROR_FOLDER = dropboxWithRoot(
  Deno.env.get("UK_AIR_ERROR_DROPBOX_FOLDER") ?? "error_log",
);
const DROPBOX_LOG_RETENTION_DAYS = 31;
const DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const DROPBOX_UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload";
const DROPBOX_LIST_FOLDER_URL = "https://api.dropboxapi.com/2/files/list_folder";
const DROPBOX_DELETE_URL = "https://api.dropboxapi.com/2/files/delete_v2";

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

const ERROR_LOGGER = createErrorLogger(
  loadErrorDropboxConfig(),
  Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
);

function logUnhandledError(
  message: string,
  err: unknown,
  context: Record<string, unknown>,
): void {
  const error = err instanceof Error ? err : new Error(String(err));
  void ERROR_LOGGER.logError({
    source: "edge",
    severity: "error",
    message,
    stack: error.stack,
    context,
  });
}

addEventListener("error", (event) => {
  if (typeof event.preventDefault === "function") {
    event.preventDefault();
  }
  logUnhandledError(
    "Unhandled error event.",
    event.error ?? event.message,
    {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    },
  );
});

addEventListener("unhandledrejection", (event) => {
  if (typeof event.preventDefault === "function") {
    event.preventDefault();
  }
  logUnhandledError(
    "Unhandled promise rejection.",
    event.reason,
    {
      reason: event.reason instanceof Error ? event.reason.message : String(event.reason),
    },
  );
});

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const log = createLogBuffer();
  const dropboxConfig = loadDropboxConfig();
  const errorLogger = ERROR_LOGGER;
  const rawRecorder = dropboxConfig ? createRawRecorder() : null;
  const errors: string[] = [];
  let status = 200;
  let polled = 0;
  let observationsUpserted = 0;
  let responsePayload: Record<string, unknown> = {};
  let service: ServiceRow | null = null;
  let requestedServiceId: string | undefined;
  let requestedServiceLabel = UK_AIR_SOS_SERVICE_LABEL;
  let requestedWindowHours: number | undefined;
  let requestedPollutants: string[] | undefined;
  let requestedLimit: number | undefined;
  let requestedSeries: string[] | undefined;

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      status = 500;
      responsePayload = { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." };
      log.error("Missing Supabase configuration.");
    } else {
      const payload = await readJson(req);
      requestedServiceId = asString(payload?.service_id);
      requestedServiceLabel = asString(payload?.service_label) || UK_AIR_SOS_SERVICE_LABEL;
      requestedWindowHours = asNumber(payload?.window_hours, undefined);
      requestedPollutants = parseList(payload?.pollutants);
      requestedLimit = asNumber(payload?.timeseries_limit, undefined);
      requestedSeries = parseList(payload?.timeseries_ids);

      log.info("Poll request", {
        service_id: requestedServiceId ?? null,
        service_label: requestedServiceLabel,
        window_hours: requestedWindowHours ?? null,
        pollutants: requestedPollutants?.length ?? null,
        timeseries_ids: requestedSeries?.length ?? null,
        timeseries_limit: requestedLimit ?? null,
      });

      service = await loadService(requestedServiceId, requestedServiceLabel);
      if (!service) {
        status = 404;
        responsePayload = { error: "Service not found and could not be discovered." };
        log.warn("Service not found.");
      } else if (service.poll_enabled === false) {
        status = 200;
        responsePayload = { status: "poll_disabled", service_id: service.id };
        log.info("Polling disabled for service.", { service_id: service.id });
      } else {
        let shouldPoll = true;
        const pollWindow = requestedWindowHours ?? service.poll_window_hours ?? DEFAULT_WINDOW_HOURS;
        const effectiveLimit = requestedLimit ?? service.poll_timeseries_batch_size ?? undefined;
        const baseUrl = (service.service_url || UK_AIR_SOS_BASE_URL).replace(/\/$/, "");

        let series = await loadTimeseries(service.id);
        if (requestedSeries?.length) {
          const requestedSet = new Set(requestedSeries.map((value) => value.toLowerCase()));
          series = series.filter((row) => {
            const idMatch = row.id && requestedSet.has(String(row.id).toLowerCase());
            const sourceMatch = row.timeseries_ref
              && requestedSet.has(String(row.timeseries_ref).toLowerCase());
            return idMatch || sourceMatch;
          });
        }

        if (requestedPollutants?.length) {
          const allowedPhenomena = await loadPhenomena(service.id, requestedPollutants);
          if (allowedPhenomena.size === 0) {
            status = 200;
            responsePayload = { status: "no_matching_pollutants", service_id: service.id };
            log.warn("No matching pollutants for service.", { service_id: service.id });
            shouldPoll = false;
          } else {
            series = series.filter((row) =>
              row.phenomenon_id && allowedPhenomena.has(row.phenomenon_id)
            );
          }
        }

        if (shouldPoll) {
          if (typeof effectiveLimit === "number" && effectiveLimit > 0) {
            series = series.slice(0, effectiveLimit);
          }

          const now = new Date();
          const windowStart = new Date(now.getTime() - pollWindow * 60 * 60 * 1000);
          const timespan = `${windowStart.toISOString()}/${now.toISOString()}`;
          if (rawRecorder) {
            rawRecorder.recordEvent("context", {
              service_id: service.id,
              service_ref: service.service_ref,
              service_label: service.label,
              timespan,
              window_hours: pollWindow,
              timeseries_limit: typeof effectiveLimit === "number" ? effectiveLimit : null,
              pollutants: requestedPollutants?.length ? requestedPollutants : "all",
            });
          }

          await runPool(series, CONCURRENCY_LIMIT, async (row) => {
            try {
              const sourceId = row.timeseries_ref || String(row.id);
              const data = await fetchJson(
                baseUrl,
                `/timeseries/${encodeURIComponent(sourceId)}/getData`,
                { timespan, format: "tvp" },
                rawRecorder,
              );
              const points = parseDatapoints(data?.values, row.id);
              if (points.length) {
                const { error } = await postgrestRequest(
                  "POST",
                  "observations",
                  { on_conflict: "timeseries_id,observed_at" },
                  points.map((point) => ({
                    timeseries_id: row.id,
                    observed_at: point.observed_at,
                    value: point.value,
                    status: point.status,
                  })),
                  "resolution=merge-duplicates,return=minimal",
                );
                if (error) {
                  throw new Error(`observations upsert failed for ${row.id}: ${error.message}`);
                }
                observationsUpserted += points.length;
              }
              await upsertLastValue(
                row.id,
                data,
                points,
                errorLogger,
                service?.id ?? requestedServiceId ?? null,
              );
              polled += 1;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              errors.push(`${row.id}: ${message}`);
              console.warn(`Poll failed for ${row.id}: ${message}`);
              await errorLogger.logError({
                source: "edge",
                severity: "error",
                message: `Poll failed for timeseries ${row.id}.`,
                stack: err instanceof Error ? err.stack : undefined,
                context: {
                  timeseries_ref: row.timeseries_ref,
                  timespan,
                  service_id: service?.id ?? requestedServiceId ?? null,
                },
                service_id: service?.id ?? requestedServiceId ?? null,
                timeseries_id: row.id,
              });
            }
          });

          const { error: pollUpdateError } = await postgrestRequest(
            "PATCH",
            "services",
            { id: `eq.${service.id}` },
            { last_polled_at: now.toISOString() },
            "return=minimal",
          );
          if (pollUpdateError) {
            errors.push(`service last_polled_at update failed: ${pollUpdateError.message}`);
            await errorLogger.logError({
              source: "edge",
              severity: "error",
              message: "Failed to update services.last_polled_at.",
              context: {
                service_id: service.id,
                error: pollUpdateError.message,
              },
              service_id: service.id,
            });
          }

          status = errors.length ? 207 : 200;
          responsePayload = {
            status: "ok",
            service_id: service.id,
            series_polled: polled,
            observations_upserted: observationsUpserted,
            errors,
          };
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(message);
    status = 500;
    responsePayload = { error: "Unhandled error", message };
    log.error("Unhandled error during poll.", { message });
    await errorLogger.logError({
      source: "edge",
      severity: "error",
      message: "Unhandled error during poll.",
      stack: err instanceof Error ? err.stack : undefined,
      context: {
        service_id: requestedServiceId ?? null,
        service_label: requestedServiceLabel,
      },
      service_id: requestedServiceId ?? null,
    });
  } finally {
    log.info("Poll summary", {
      service_id: service?.id ?? requestedServiceId ?? null,
      series_polled: polled,
      observations_upserted: observationsUpserted,
      errors: errors.length,
    });
    if (errors.length) {
      log.warn("Poll errors", { sample: errors.slice(0, 25) });
    }
    let accessToken: string | null = null;
    const refreshDropbox = dropboxConfig
      ? () => dropboxRefreshAccessToken(dropboxConfig)
      : undefined;
    if (dropboxConfig) {
      try {
        accessToken = await dropboxRefreshAccessToken(dropboxConfig);
      } catch (err) {
        console.warn("Dropbox token request failed:", err);
      }
    }
    if (accessToken) {
      accessToken = await uploadDropboxLog(
        accessToken,
        log,
        service?.id ?? requestedServiceId ?? null,
        errorLogger,
        refreshDropbox,
      );
      accessToken = await uploadDropboxRaw(
        accessToken,
        rawRecorder,
        service?.id ?? requestedServiceId ?? null,
        errorLogger,
        refreshDropbox,
      );
    }
  }

  return json(responsePayload, status);
});

async function readJson(req: Request): Promise<PollRequest | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type LogBuffer = {
  lines: string[];
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
};

type RawRecorder = {
  lines: string[];
  responseCount: number;
  recordEvent: (name: string, payload: Record<string, unknown>) => void;
  recordResponse: (
    path: string,
    params: Record<string, string>,
    statusCode: number,
    payload: unknown,
  ) => void;
};

function createLogBuffer(): LogBuffer {
  const lines: string[] = [];
  const push = (level: string, message: string, context?: Record<string, unknown>) => {
    const timestamp = new Date().toISOString();
    const base = `${timestamp} ${level} ${message}`;
    lines.push(context ? `${base} ${formatContext(context)}` : base);
  };
  return {
    lines,
    info: (message, context) => push("INFO", message, context),
    warn: (message, context) => push("WARN", message, context),
    error: (message, context) => push("ERROR", message, context),
  };
}

function formatContext(context: Record<string, unknown>): string {
  return Object.entries(context)
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(" ");
}

function formatLogValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => formatLogValue(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
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

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function asNumber(value: unknown, fallback: number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function parseList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    const parts = value.split(",").map((item) => item.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  }
  return undefined;
}

function normalizeServiceLabel(label: string | undefined): string {
  if (!label) {
    return UK_AIR_SOS_SERVICE_LABEL;
  }
  const trimmed = label.trim();
  if (!trimmed) {
    return UK_AIR_SOS_SERVICE_LABEL;
  }
  if (trimmed.toLowerCase().startsWith("my timeseries service")) {
    return UK_AIR_SOS_SERVICE_LABEL;
  }
  return trimmed;
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

function loadErrorDropboxConfig(): DropboxConfig | null {
  if (!DROPBOX_APP_KEY || !DROPBOX_APP_SECRET || !DROPBOX_REFRESH_TOKEN) {
    return null;
  }
  return {
    appKey: DROPBOX_APP_KEY,
    appSecret: DROPBOX_APP_SECRET,
    refreshToken: DROPBOX_REFRESH_TOKEN,
  };
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
  if (!DROPBOX_ROOT_FOLDER) {
    return cleaned;
  }
  if (!cleaned) {
    return DROPBOX_ROOT_FOLDER;
  }
  if (cleaned === DROPBOX_ROOT_FOLDER || cleaned.startsWith(`${DROPBOX_ROOT_FOLDER}/`)) {
    return cleaned;
  }
  return `${DROPBOX_ROOT_FOLDER}${cleaned}`;
}

function buildDropboxLogPath(serviceId: string | null, timestamp: Date): string {
  const stamp = formatCompactTimestamp(timestamp);
  const dateFolder = formatDateYmd(timestamp);
  const suffix = serviceId ? `_service_${serviceId}` : "";
  return `${DROPBOX_LOG_FOLDER}/${dateFolder}/uk_air_log_edge_${stamp}${suffix}.log`;
}

function buildDropboxRawPath(serviceId: string | null, timestamp: Date): string {
  const stamp = formatCompactTimestamp(timestamp);
  const dateFolder = formatDateYmd(timestamp);
  const suffix = serviceId ? `_service_${serviceId}` : "";
  return `${DROPBOX_RAW_FOLDER}/${dateFolder}/uk_air_raw_edge_${stamp}${suffix}.zip`;
}

function buildDropboxErrorPath(errorId: string, createdAt: string): string {
  const dateFolder = createdAt.slice(0, 10);
  const stamp = formatCompactTimestamp(new Date(createdAt));
  return `${DROPBOX_ERROR_FOLDER}/${dateFolder}/uk_air_error_${stamp}_${errorId}.json`;
}

function formatCompactTimestamp(timestamp: Date): string {
  return timestamp.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function formatDateYmd(timestamp: Date): string {
  return timestamp.toISOString().slice(0, 10);
}

async function uploadDropboxLog(
  accessToken: string,
  log: LogBuffer,
  serviceId: string | null,
  errorLogger: { logError: (entry: ErrorLogEntry) => Promise<void> },
  refreshToken?: () => Promise<string>,
): Promise<string> {
  if (!accessToken) {
    return accessToken;
  }
  const content = log.lines.join("\n") + "\n";
  if (!content.trim()) {
    return accessToken;
  }
  try {
    const logPath = buildDropboxLogPath(serviceId, new Date());
    accessToken = await dropboxUploadFileWithRetry(
      accessToken,
      logPath,
      content,
      refreshToken,
    );
    await dropboxArchiveLogs(accessToken, DROPBOX_LOG_FOLDER, DROPBOX_LOG_RETENTION_DAYS, 365);
  } catch (err) {
    console.warn("Dropbox log upload failed:", err);
    await errorLogger.logError({
      source: "edge",
      severity: "error",
      message: "Dropbox log upload failed.",
      stack: err instanceof Error ? err.stack : undefined,
      context: {
        service_id: serviceId,
        error: err instanceof Error ? err.message : String(err),
      },
      service_id: serviceId ?? null,
    });
  }
  return accessToken;
}

async function uploadDropboxRaw(
  accessToken: string,
  recorder: RawRecorder | null,
  serviceId: string | null,
  errorLogger: { logError: (entry: ErrorLogEntry) => Promise<void> },
  refreshToken?: () => Promise<string>,
): Promise<string> {
  if (!accessToken || !recorder || recorder.responseCount === 0) {
    return accessToken;
  }
  const content = recorder.lines.join("\n") + "\n";
  if (!content.trim()) {
    return accessToken;
  }
  try {
    const rawPath = buildDropboxRawPath(serviceId, new Date());
    const filename = rawPath.split("/").pop() ?? "uk_air_raw_edge.jsonl";
    const jsonlName = filename.replace(/\.zip$/i, ".jsonl");
    const zipped = await zipTextCompressed(jsonlName, content);
    accessToken = await dropboxUploadFileWithRetry(
      accessToken,
      rawPath,
      zipped,
      refreshToken,
    );
  } catch (err) {
    console.warn("Dropbox raw upload failed:", err);
    await errorLogger.logError({
      source: "edge",
      severity: "error",
      message: "Dropbox raw upload failed.",
      stack: err instanceof Error ? err.stack : undefined,
      context: {
        service_id: serviceId,
        error: err instanceof Error ? err.message : String(err),
      },
      service_id: serviceId ?? null,
    });
  }
  return accessToken;
}

function createErrorLogger(config: DropboxConfig | null, enabled: boolean) {
  let accessToken: string | null = null;
  return {
    async logError(entry: ErrorLogEntry): Promise<void> {
      if (!enabled) {
        return;
      }
      const errorId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const row = {
        id: errorId,
        source: entry.source,
        severity: entry.severity,
        message: entry.message,
        stack: entry.stack ?? null,
        context: entry.context ?? null,
        service_id: entry.service_id ?? null,
        station_id: entry.station_id ?? null,
        timeseries_id: entry.timeseries_id ?? null,
      };
      const { error } = await postgrestRequest(
        "POST",
        "error_logs",
        undefined,
        row,
        "return=minimal",
      );
      if (error) {
        console.warn("error_logs insert failed:", error.message);
        return;
      }
      if (!config) {
        return;
      }
      try {
        if (!accessToken) {
          accessToken = await dropboxRefreshAccessToken(config);
        }
        const dropboxPath = buildDropboxErrorPath(errorId, createdAt);
        const payload = {
          ...row,
          created_at: createdAt,
          dropbox_path: dropboxPath,
        };
        accessToken = await dropboxUploadFileWithRetry(
          accessToken,
          dropboxPath,
          JSON.stringify(payload, null, 2),
          () => dropboxRefreshAccessToken(config),
        );
        await postgrestRequest(
          "PATCH",
          "error_logs",
          { id: `eq.${errorId}` },
          { dropbox_path: dropboxPath },
          "return=minimal",
        );
      } catch (err) {
        console.warn("Dropbox error log upload failed:", err);
      }
    },
  };
}

class DropboxHttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function dropboxRefreshAccessToken(config: DropboxConfig): Promise<string> {
  const payload = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: config.refreshToken,
    client_id: config.appKey,
    client_secret: config.appSecret,
  });
  const resp = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    body: payload,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!resp.ok) {
    throw new Error(`Dropbox token request failed (${resp.status})`);
  }
  const data = await resp.json();
  const token = data?.access_token;
  if (!token) {
    throw new Error("Dropbox token response missing access_token.");
  }
  return token;
}

async function dropboxUploadFile(
  accessToken: string,
  path: string,
  contents: string | Uint8Array,
): Promise<void> {
  const body = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
  const resp = await fetch(DROPBOX_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Dropbox-API-Arg": JSON.stringify({
        path,
        mode: "add",
        autorename: true,
        mute: false,
      }),
      "Content-Type": "application/octet-stream",
    },
    body,
  });
  if (!resp.ok) {
    throw new DropboxHttpError(`Dropbox upload failed (${resp.status})`, resp.status);
  }
}

async function dropboxUploadFileWithRetry(
  accessToken: string,
  path: string,
  contents: string | Uint8Array,
  refreshToken?: () => Promise<string>,
): Promise<string> {
  try {
    await dropboxUploadFile(accessToken, path, contents);
    return accessToken;
  } catch (err) {
    if (err instanceof DropboxHttpError && err.status === 401 && refreshToken) {
      const refreshed = await refreshToken();
      await dropboxUploadFile(refreshed, path, contents);
      return refreshed;
    }
    throw err;
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

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function dropboxArchiveLogs(
  accessToken: string,
  folder: string,
  days: number,
  archiveDays: number,
): Promise<void> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const archiveCutoff = Date.now() - archiveDays * 24 * 60 * 60 * 1000;
  const archiveFolder = `${folder}/archive`;
  const listFolder = async (path: string): Promise<Array<Record<string, unknown>>> => {
    let payload: Record<string, unknown> = { path };
    const entries: Array<Record<string, unknown>> = [];
    while (true) {
      const resp = await fetch(DROPBOX_LIST_FOLDER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (resp.status === 409) {
        return [];
      }
      if (!resp.ok) {
        throw new Error(`Dropbox list_folder failed (${resp.status})`);
      }
      const data = await resp.json();
      entries.push(...(Array.isArray(data?.entries) ? data.entries : []));
      if (!data?.has_more) {
        return entries;
      }
      payload = { cursor: data.cursor };
    }
  };

  const [rootEntries, archiveEntries] = await Promise.all([
    listFolder(folder),
    listFolder(archiveFolder),
  ]);
  const archiveNames = new Set(
    archiveEntries
      .filter((entry) => entry?.[".tag"] === "file")
      .map((entry) => String(entry?.name ?? "")),
  );

  for (const entry of rootEntries) {
    if (entry?.[".tag"] !== "folder") {
      continue;
    }
    const name = String(entry?.name ?? "");
    if (!name || name === "archive") {
      continue;
    }
    const parsed = parseYmd(name);
    if (!parsed || parsed.getTime() >= cutoff) {
      continue;
    }
    const archiveName = `${name}.zip`;
    const folderPath = String(entry?.path_lower || entry?.path_display || "");
    if (!folderPath) {
      continue;
    }
    if (!archiveNames.has(archiveName)) {
      const zipped = await dropboxDownloadZip(accessToken, folderPath);
      await dropboxUploadFile(accessToken, `${archiveFolder}/${archiveName}`, new Uint8Array(zipped));
      archiveNames.add(archiveName);
    }
    await fetch(DROPBOX_DELETE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: folderPath }),
    });
  }

  for (const entry of archiveEntries) {
    if (entry?.[".tag"] !== "file") {
      continue;
    }
    const name = String(entry?.name ?? "");
    if (!name.endsWith(".zip")) {
      continue;
    }
    const parsed = parseYmd(name.slice(0, -4));
    if (!parsed || parsed.getTime() >= archiveCutoff) {
      continue;
    }
    const path = String(entry?.path_lower || entry?.path_display || "");
    if (!path) {
      continue;
    }
    await fetch(DROPBOX_DELETE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path }),
    });
  }
}

async function dropboxDownloadZip(accessToken: string, path: string): Promise<ArrayBuffer> {
  const resp = await fetch(DROPBOX_DOWNLOAD_ZIP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Dropbox-API-Arg": JSON.stringify({ path }),
    },
  });
  if (!resp.ok) {
    throw new Error(`Dropbox download_zip failed (${resp.status})`);
  }
  return await resp.arrayBuffer();
}

function parseYmd(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day));
}

async function loadService(
  serviceId: string | undefined,
  serviceLabel: string,
): Promise<ServiceRow | null> {
  const select =
    "id,service_ref,label,service_url,poll_enabled,poll_window_hours,poll_timeseries_batch_size";
  if (serviceId) {
    const { data } = await postgrestRequest<ServiceRow[]>("GET", "services", {
      select,
      id: `eq.${serviceId}`,
      limit: "1",
    });
    if (data && data[0]) {
      return data[0];
    }
    const { data: refData } = await postgrestRequest<ServiceRow[]>("GET", "services", {
      select,
      service_ref: `eq.${serviceId}`,
      limit: "1",
    });
    if (refData && refData[0]) {
      return refData[0];
    }
  }

  if (serviceLabel) {
    const { data } = await postgrestRequest<ServiceRow[]>("GET", "services", {
      select,
      label: `ilike.%${serviceLabel}%`,
      limit: "1",
    });
    if (data && data[0]) {
      return data[0];
    }
  }

  const discovered = await discoverService(serviceId, serviceLabel);
  if (!discovered) {
    return null;
  }
  await postgrestRequest(
    "POST",
    "services",
    { on_conflict: "service_ref" },
    [discovered],
    "resolution=merge-duplicates,return=minimal",
  );
  const { data } = await postgrestRequest<ServiceRow[]>("GET", "services", {
    select,
    service_ref: `eq.${discovered.service_ref}`,
    limit: "1",
  });
  return data && data[0] ? data[0] : null;
}

async function discoverService(
  preferredId: string | undefined,
  preferredLabel: string,
): Promise<{ service_ref: string; label: string; service_url: string } | null> {
  try {
    const data = await fetchJson(UK_AIR_SOS_BASE_URL, "/services", {});
    const services = extractList(data, ["services", "data"]);
    if (!services.length) {
      return null;
    }
    if (preferredId) {
      const match = services.find((svc) => String(svc?.id) === preferredId);
      if (match) {
        return {
          service_ref: String(match.id),
          label: normalizeServiceLabel(match.label || match.name),
          service_url: match.serviceUrl || match.url || UK_AIR_SOS_BASE_URL,
        };
      }
    }
    const needle = preferredLabel.toLowerCase();
    const labelMatch = services.find((svc) =>
      String(svc?.label || "").toLowerCase().includes(needle)
    );
    if (labelMatch) {
      return {
        service_ref: String(labelMatch.id),
        label: normalizeServiceLabel(labelMatch.label || labelMatch.name),
        service_url: labelMatch.serviceUrl || labelMatch.url || UK_AIR_SOS_BASE_URL,
      };
    }
    const fallback = services.find((svc) =>
      String(svc?.label || "").toLowerCase().includes("uk")
        && String(svc?.label || "").toLowerCase().includes("air")
    ) || services[0];
    return {
      service_ref: String(fallback.id),
      label: normalizeServiceLabel(fallback.label || fallback.name),
      service_url: fallback.serviceUrl || fallback.url || UK_AIR_SOS_BASE_URL,
    };
  } catch (err) {
    console.warn("Service discovery failed:", err);
    return null;
  }
}

async function loadTimeseries(
  serviceId: string,
): Promise<Array<{ id: number; timeseries_ref: string | null; phenomenon_id: string | null }>> {
  const rows: Array<{ id: number; timeseries_ref: string | null; phenomenon_id: string | null }> = [];
  let offset = 0;
  while (true) {
    const { data, error } = await postgrestRequest<
      Array<{ id: number; timeseries_ref: string | null; phenomenon_id: string | null }>
    >("GET", "timeseries", {
      select: "id,timeseries_ref,phenomenon_id",
      service_id: `eq.${serviceId}`,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (error) {
      throw new Error(`Failed to load timeseries: ${error.message}`);
    }
    if (!data || data.length === 0) {
      break;
    }
    rows.push(...data.map((row) => ({
      id: Number(row.id),
      timeseries_ref: row.timeseries_ref ? String(row.timeseries_ref) : null,
      phenomenon_id: row.phenomenon_id ? String(row.phenomenon_id) : null,
    })));
    if (data.length < PAGE_SIZE) {
      break;
    }
    offset += PAGE_SIZE;
  }
  return rows;
}

async function loadPhenomena(serviceId: string, filters: string[]): Promise<Set<string>> {
  const needle = new Set(filters.map((value) => value.toLowerCase()));
  const { data, error } = await postgrestRequest<
    Array<{ id: string; label: string | null; notation: string | null; eionet_uri: string | null }>
  >("GET", "phenomena", {
    select: "id,label,notation,eionet_uri",
    service_id: `eq.${serviceId}`,
  });
  if (error) {
    throw new Error(`Failed to load phenomena: ${error.message}`);
  }
  const matches = new Set<string>();
  for (const row of data || []) {
    const id = row.id ? String(row.id) : "";
    const label = row.label ? String(row.label) : "";
    const notation = row.notation ? String(row.notation) : "";
    const uri = row.eionet_uri ? String(row.eionet_uri) : "";
    if (
      (id && needle.has(id.toLowerCase())) ||
      (label && needle.has(label.toLowerCase())) ||
      (notation && needle.has(notation.toLowerCase())) ||
      (uri && needle.has(uri.toLowerCase()))
    ) {
      if (id) {
        matches.add(id);
      }
    }
  }
  return matches;
}

function extractList(payload: unknown, keys: string[]): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload as Array<Record<string, unknown>>;
  }
  if (payload && typeof payload === "object") {
    for (const key of keys) {
      const items = (payload as Record<string, unknown>)[key];
      if (Array.isArray(items)) {
        return items as Array<Record<string, unknown>>;
      }
    }
  }
  return [];
}

async function fetchJson(
  baseUrl: string,
  path: string,
  params: Record<string, string>,
  recorder?: RawRecorder | null,
): Promise<any> {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const resp = await fetch(url.toString(), { signal: controller.signal });
    const contentType = resp.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await resp.json()
      : await resp.text();
    if (recorder) {
      recorder.recordResponse(path, params, resp.status, payload);
    }
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

let emptySeriesLogs = 0;

function parseDatapoints(
  values: unknown,
  seriesId?: number,
): Array<{ observed_at: string; value: number | null; status: string | null }> {
  let rows = values;
  if (!Array.isArray(rows) && rows && typeof rows === "object") {
    const nested = (rows as Record<string, unknown>).values
      ?? (rows as Record<string, unknown>).data;
    if (Array.isArray(nested)) {
      rows = nested;
    }
  }
  if (!Array.isArray(rows)) {
    logEmptySeries(seriesId, rows, "values not array");
    return [];
  }
  const points: Array<{ observed_at: string; value: number | null; status: string | null }> = [];
  for (const row of rows) {
    if (Array.isArray(row)) {
      if (row.length < 2) {
        continue;
      }
      const observedAt = parseTimestamp(row[0]);
      if (!observedAt) {
        continue;
      }
      const value = toNumber(row[1]);
      const status = row.length > 2 && row[2] != null ? String(row[2]) : null;
      points.push({
        observed_at: observedAt.toISOString(),
        value,
        status,
      });
      continue;
    }
    if (row && typeof row === "object") {
      const record = row as Record<string, unknown>;
      const observedAt = parseTimestamp(
        record.timestamp ?? record.time ?? record.phenomenonTime ?? record.dateTime ?? record.datetime,
      );
      if (!observedAt) {
        continue;
      }
      const value = toNumber(record.value ?? record.result ?? record.v);
      const status = record.status != null ? String(record.status)
        : record.quality != null ? String(record.quality)
        : record.qc != null ? String(record.qc)
        : null;
      points.push({
        observed_at: observedAt.toISOString(),
        value,
        status,
      });
    }
  }
  if (!points.length) {
    logEmptySeries(seriesId, rows[0], "no parsed datapoints");
  }
  return points;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  return num;
}

function parseTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const timestamp = value < 1e12 ? value * 1000 : value;
    const observedAt = new Date(timestamp);
    return Number.isNaN(observedAt.getTime()) ? null : observedAt;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      const timestamp = numeric < 1e12 ? numeric * 1000 : numeric;
      const observedAt = new Date(timestamp);
      return Number.isNaN(observedAt.getTime()) ? null : observedAt;
    }
    const observedAt = new Date(trimmed);
    return Number.isNaN(observedAt.getTime()) ? null : observedAt;
  }
  return null;
}

function logEmptySeries(seriesId: number | undefined, sample: unknown, reason: string): void {
  if (emptySeriesLogs >= 3) {
    return;
  }
  emptySeriesLogs += 1;
  console.warn("No datapoints parsed", {
    series_id: seriesId ?? null,
    reason,
    sample,
  });
}

async function upsertLastValue(
  seriesId: string,
  data: Record<string, unknown>,
  points: Array<{ observed_at: string; value: number | null }>,
  errorLogger: { logError: (entry: ErrorLogEntry) => Promise<void> },
  serviceId: string | null,
): Promise<void> {
  const lastValue = toNumber(data?.lastValue);
  const lastValueTimestamp = data?.lastValueTimestamp;
  let lastValueAt: string | null = null;
  if (typeof lastValueTimestamp === "string") {
    const parsed = new Date(lastValueTimestamp);
    if (!Number.isNaN(parsed.getTime())) {
      lastValueAt = parsed.toISOString();
    }
  } else if (typeof lastValueTimestamp === "number") {
    lastValueAt = new Date(lastValueTimestamp).toISOString();
  } else if (points.length) {
    lastValueAt = points[points.length - 1].observed_at;
  }

  if (!lastValueAt && lastValue === null) {
    return;
  }
  const payload: Record<string, unknown> = {};
  if (lastValueAt) {
    payload.last_value_at = lastValueAt;
  }
  if (lastValue !== null) {
    payload.last_value = lastValue;
  }
  const { error } = await postgrestRequest(
    "PATCH",
    "timeseries",
    { id: `eq.${seriesId}` },
    payload,
    "return=minimal",
  );
  if (error) {
    console.warn(`timeseries update failed for ${seriesId}: ${error.message}`);
    await errorLogger.logError({
      source: "edge",
      severity: "error",
      message: "Failed to update timeseries last_value fields.",
      context: {
        timeseries_id: seriesId,
        service_id: serviceId,
        error: error.message,
      },
      service_id: serviceId ?? null,
      timeseries_id: seriesId,
    });
  }
}

async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const task = worker(item).finally(() => executing.delete(task));
    executing.add(task);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}
