// Dispatch connector polls based on connectors table settings.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  flushHistoryOutbox,
  type HistoryOutboxFlushStats,
} from "../_shared/history_client.ts";

type ConnectorRow = {
  id: string;
  connector_code: string;
  poll_enabled: boolean | null;
  poll_interval_minutes: number | null;
  poll_window_hours: number | null;
  poll_timeseries_batch_size: number | null;
  last_polled_at: string | null;
  last_run_start: string | null;
  last_run_end: string | null;
  last_run_status: string | null;
};

type IngestRunRow = {
  connector_id: string | null;
  connector_code: string | null;
  run_started_at: string | null;
  run_ended_at: string | null;
  run_status: string | null;
};

type DispatcherSettings = {
  dispatcher_parallel_ingest: boolean;
  max_runs_per_dispatch_call: number;
};

type DispatchResult = {
  connector_code: string;
  status: string;
  detail?: string;
  response_status?: number;
};

type DispatchMode = "enqueue" | "run_queue" | "legacy";

type DispatchCandidate = {
  connectorCode: string;
  connector: ConnectorRow | null;
  lastPolledMs: number;
  queueJobId?: number;
};

type DispatchQueueClaimRow = {
  id: number;
  connector_code: string;
  payload: Record<string, unknown> | null;
  attempts: number;
};

type RunMetrics = {
  stations_updated: number | null;
  observations_upserted: number | null;
  timeseries_updated: number | null;
  series_polled: number | null;
};

type RunScope = {
  stationRefs?: string[];
  timeseriesIds?: string[];
};

type ErrorLogEntry = {
  severity: "error" | "warn";
  message: string;
  context?: Record<string, unknown> | null;
  connector_id?: string | number | null;
};

type HistoryOutboxDrainSummary = HistoryOutboxFlushStats & {
  batches: number;
  warnings: string[];
  max_batches: number;
  error?: string;
  stopped_early?: boolean;
  stop_reason?: string;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ??
  Deno.env.get("SB_SUPABASE_URL") ??
  "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SB_SERVICE_ROLE_KEY") ??
  "";
const SB_ANON_JWT = Deno.env.get("SB_ANON_JWT") ?? "";
const SB_UK_AQ_CRON_SECRET = Deno.env.get("SB_UK_AQ_CRON_SECRET") ?? "";
const UK_AQ_CORE_SCHEMA = Deno.env.get("UK_AQ_CORE_SCHEMA") ??
  "uk_aq_core";
const UK_AQ_RAW_SCHEMA = Deno.env.get("UK_AQ_RAW_SCHEMA") ??
  "uk_aq_raw";

const REST_BASE_URL = SUPABASE_URL
  ? `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1`
  : "";

const TARGET_CONNECTORS = [
  "uk_air_sos",
  "sensorcommunity",
  "breathelondon",
  "erg_laqn",
  "openaq",
];

const DEFAULT_INTERVAL_MINUTES: Record<string, number> = {
  uk_air_sos: 60,
  sensorcommunity: 15,
  breathelondon: 60,
  erg_laqn: 60,
  openaq: 60,
};

const DEFAULT_WINDOW_HOURS: Record<string, number> = {
  uk_air_sos: 6,
  breathelondon: 6,
  erg_laqn: 24,
  openaq: 6,
};

const DEFAULT_BATCH_LIMIT: Record<string, number> = {
  breathelondon: 10,
  erg_laqn: 10,
  openaq: 56,
};

const IN_FLIGHT_TIMEOUT_MINUTES_ENV = Deno.env.get("IN_FLIGHT_TIMEOUT_MINUTES");
const IN_FLIGHT_TIMEOUT_MINUTES = (() => {
  const parsed = IN_FLIGHT_TIMEOUT_MINUTES_ENV
    ? Number(IN_FLIGHT_TIMEOUT_MINUTES_ENV)
    : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
})();
const DEFAULT_PARALLEL_INGEST = false;
const DEFAULT_MAX_RUNS_PER_DISPATCH_CALL = 1;
const MIN_EDGE_CALL_TIMEOUT_MS = 5000;
const MIN_DISPATCH_TIME_BUDGET_MS = MIN_EDGE_CALL_TIMEOUT_MS + 1000;
const MIN_DISPATCH_SHUTDOWN_BUFFER_MS = 1000;
const HISTORY_OUTBOX_DISPATCH_MAX_FLUSHES = parsePositiveInt(
  Deno.env.get("HISTORY_OUTBOX_DISPATCH_MAX_FLUSHES"),
  3,
);
const DISPATCH_QUEUE_CLAIM_BATCH_LIMIT = parsePositiveInt(
  Deno.env.get("DISPATCH_QUEUE_CLAIM_BATCH_LIMIT"),
  1,
);
const DISPATCH_QUEUE_LEASE_SECONDS = parsePositiveInt(
  Deno.env.get("DISPATCH_QUEUE_LEASE_SECONDS"),
  900,
);
const DISPATCH_TIME_BUDGET_MS = parseMillisecondsSetting(
  Deno.env.get("DISPATCH_TIME_BUDGET_MS"),
  150000,
  MIN_DISPATCH_TIME_BUDGET_MS,
);
const DISPATCH_SHUTDOWN_BUFFER_MS = parseMillisecondsSetting(
  Deno.env.get("DISPATCH_SHUTDOWN_BUFFER_MS"),
  10000,
  MIN_DISPATCH_SHUTDOWN_BUFFER_MS,
);
const DISPATCH_EDGE_CALL_TIMEOUT_MS = parseMillisecondsSetting(
  Deno.env.get("DISPATCH_EDGE_CALL_TIMEOUT_MS"),
  140000,
  MIN_EDGE_CALL_TIMEOUT_MS,
);
const DISPATCH_EFFECTIVE_SHUTDOWN_BUFFER_MS = Math.min(
  DISPATCH_SHUTDOWN_BUFFER_MS,
  Math.max(0, DISPATCH_TIME_BUDGET_MS - MIN_EDGE_CALL_TIMEOUT_MS),
);

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? "");
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.trunc(value));
}

function parseMillisecondsSetting(
  raw: string | undefined,
  fallback: number,
  minValue: number,
): number {
  const value = Number(raw ?? "");
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.trunc(value);
  if (normalized < minValue) {
    return fallback;
  }
  return normalized;
}

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

function asPayloadObject(payload: unknown): Record<string, unknown> | null {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return null;
}

function getPayloadNumber(
  payload: Record<string, unknown> | null,
  keys: string[],
): number | null {
  if (!payload) {
    return null;
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      const value = asNumber(payload[key]);
      if (value !== null) {
        return value;
      }
    }
  }
  return null;
}

function extractRunMetrics(
  connectorCode: string,
  payload: unknown,
): RunMetrics {
  const data = asPayloadObject(payload);
  const observations = getPayloadNumber(data, [
    "observations_upserted",
    "observations",
  ]);
  const stations = getPayloadNumber(data, [
    "stations_polled",
    "stations_processed",
    "stations_selected",
    "stations_updated",
    "stations",
  ]);
  const timeseries = getPayloadNumber(data, [
    "timeseries_updated",
    "timeseries",
  ]);
  const seriesPolled = getPayloadNumber(data, ["series_polled"]);
  if (connectorCode === "uk_air_sos") {
    return {
      stations_updated: null,
      observations_upserted: observations,
      timeseries_updated: null,
      series_polled: seriesPolled,
    };
  }
  return {
    stations_updated: stations,
    observations_upserted: observations,
    timeseries_updated: timeseries,
    series_polled: seriesPolled,
  };
}

async function loadStationIdsByRefs(
  connectorId: string,
  stationRefs: string[],
): Promise<string[]> {
  if (!stationRefs.length) {
    return [];
  }
  const { data, error } = await postgrestRequest<Array<{ id: number }>>(
    "GET",
    "stations",
    {
      select: "id",
      connector_id: `eq.${connectorId}`,
      station_ref: postgrestIn(stationRefs),
      limit: "1000",
    },
  );
  if (error) {
    throw new Error(`Failed to load station ids: ${error.message}`);
  }
  return (data ?? []).map((row) => String(row.id)).filter(Boolean);
}

async function fetchMaxTimeseriesLastValueAt(
  params: Record<string, string>,
): Promise<string | null> {
  const { data, error } = await postgrestRequest<
    Array<{ last_value_at: string | null }>
  >(
    "GET",
    "timeseries",
    {
      select: "last_value_at",
      last_value_at: "not.is.null",
      order: "last_value_at.desc.nullslast",
      limit: "1",
      ...params,
    },
  );
  if (error) {
    throw new Error(
      `Failed to load timeseries last_value_at: ${error.message}`,
    );
  }
  const value = data && data.length ? data[0]?.last_value_at : null;
  return value ? String(value) : null;
}

async function resolveLastObservedAt(
  connectorId: string | null,
  scope: RunScope,
): Promise<string | null> {
  if (!connectorId) {
    return null;
  }
  if (scope.timeseriesIds && scope.timeseriesIds.length) {
    return await fetchMaxTimeseriesLastValueAt({
      id: postgrestIn(scope.timeseriesIds),
    });
  }
  if (scope.stationRefs && scope.stationRefs.length) {
    const stationIds = await loadStationIdsByRefs(
      connectorId,
      scope.stationRefs,
    );
    if (!stationIds.length) {
      return null;
    }
    return await fetchMaxTimeseriesLastValueAt({
      connector_id: `eq.${connectorId}`,
      station_id: postgrestIn(stationIds),
    });
  }
  return await fetchMaxTimeseriesLastValueAt({
    connector_id: `eq.${connectorId}`,
  });
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

function jsonResponse(
  payload: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function quotePostgrestValue(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function postgrestIn(values: string[]): string {
  return `in.(${values.map(quotePostgrestValue).join(",")})`;
}

function parseDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const candidate = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const normalized = candidate.endsWith("Z") || candidate.includes("+")
    ? candidate
    : `${candidate}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getLastPolledMs(connector: ConnectorRow | null): number {
  const lastPolled = parseDate(connector?.last_polled_at ?? null);
  return lastPolled ? lastPolled.getTime() : Number.NEGATIVE_INFINITY;
}

function getIntervalMinutes(
  connector: ConnectorRow | null,
  connectorCode: string,
): number {
  const value = connector?.poll_interval_minutes;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return DEFAULT_INTERVAL_MINUTES[connectorCode] ?? 60;
}

function getWindowHours(
  connector: ConnectorRow | null,
  connectorCode: string,
): number {
  const value = connector?.poll_window_hours;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  return DEFAULT_WINDOW_HOURS[connectorCode] ?? 24;
}

function getBatchLimit(
  connector: ConnectorRow | null,
  connectorCode: string,
): number {
  const value = connector?.poll_timeseries_batch_size;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return DEFAULT_BATCH_LIMIT[connectorCode] ?? 10;
}

function getTimeseriesLimit(connector: ConnectorRow | null): number | null {
  const value = connector?.poll_timeseries_batch_size;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return null;
}

function isDue(
  connector: ConnectorRow | null,
  connectorCode: string,
  now: Date,
): boolean {
  if (connector?.poll_enabled !== true) {
    return false;
  }
  const intervalMinutes = getIntervalMinutes(connector, connectorCode);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    return true;
  }
  const lastPolled = parseDate(connector?.last_polled_at ?? null);
  if (!lastPolled) {
    return true;
  }
  const elapsedMs = now.getTime() - lastPolled.getTime();
  return elapsedMs >= intervalMinutes * 60 * 1000;
}

function normalizeDispatcherSettings(
  settings: DispatcherSettings | null,
): DispatcherSettings {
  const parallel = settings?.dispatcher_parallel_ingest ??
    DEFAULT_PARALLEL_INGEST;
  const maxRuns = Number.isFinite(settings?.max_runs_per_dispatch_call)
    ? Math.max(1, Math.floor(settings?.max_runs_per_dispatch_call ?? 1))
    : DEFAULT_MAX_RUNS_PER_DISPATCH_CALL;
  return {
    dispatcher_parallel_ingest: Boolean(parallel),
    max_runs_per_dispatch_call: maxRuns,
  };
}

function resolveRunQueueClaimLimit(settings: DispatcherSettings): number {
  const settingsLimit = settings.dispatcher_parallel_ingest
    ? settings.max_runs_per_dispatch_call
    : 1;
  return Math.max(1, settingsLimit, DISPATCH_QUEUE_CLAIM_BATCH_LIMIT);
}

async function loadDispatcherSettings(): Promise<DispatcherSettings | null> {
  const { data, error } = await postgrestRequest<DispatcherSettings[]>(
    "GET",
    "dispatcher_settings",
    {
      select: "dispatcher_parallel_ingest,max_runs_per_dispatch_call",
      id: "eq.1",
      limit: "1",
    },
  );
  if (error) {
    console.warn("Failed to load dispatcher_settings:", error.message);
    return null;
  }
  return data && data.length ? data[0] : null;
}

function findRecentInFlightConnector(
  latestRuns: Map<string, IngestRunRow>,
  now: Date,
):
  | { connector_code: string; last_run_start: string; age_minutes: number }
  | null {
  const timeoutMs = IN_FLIGHT_TIMEOUT_MINUTES * 60 * 1000;
  let candidate: {
    connector_code: string;
    last_run_start: string;
    age_minutes: number;
  } | null = null;
  for (const [connectorCode, run] of latestRuns.entries()) {
    if (!run || run.run_ended_at) {
      continue;
    }
    const startedAt = parseDate(run.run_started_at ?? null);
    if (!startedAt) {
      continue;
    }
    const ageMs = now.getTime() - startedAt.getTime();
    if (!Number.isFinite(ageMs)) {
      continue;
    }
    if (ageMs < 0) {
      return {
        connector_code: connectorCode,
        last_run_start: startedAt.toISOString(),
        age_minutes: 0,
      };
    }
    if (ageMs <= timeoutMs) {
      const ageMinutes = Math.floor(ageMs / 60000);
      if (!candidate || ageMinutes < candidate.age_minutes) {
        candidate = {
          connector_code: connectorCode,
          last_run_start: startedAt.toISOString(),
          age_minutes: ageMinutes,
        };
      }
    }
  }
  return candidate;
}

function isConnectorInFlight(
  _connector: ConnectorRow | null,
  latestRun: IngestRunRow | null,
  now: Date,
): boolean {
  if (!latestRun || latestRun.run_ended_at) {
    return false;
  }
  const startedAt = parseDate(latestRun.run_started_at ?? null);
  if (!startedAt) {
    return false;
  }
  const ageMs = now.getTime() - startedAt.getTime();
  if (!Number.isFinite(ageMs)) {
    return true;
  }
  const timeoutMs = IN_FLIGHT_TIMEOUT_MINUTES * 60 * 1000;
  return ageMs >= 0 && ageMs <= timeoutMs;
}

async function settleStaleInFlight(
  connectors: ConnectorRow[],
  latestRuns: Map<string, IngestRunRow>,
  now: Date,
): Promise<void> {
  const timeoutMs = IN_FLIGHT_TIMEOUT_MINUTES * 60 * 1000;
  for (const connector of connectors) {
    if (!connector) {
      continue;
    }
    const latestRun = latestRuns.get(connector.connector_code ?? "");
    if (!latestRun || latestRun.run_ended_at) {
      continue;
    }
    const startedAt = parseDate(latestRun.run_started_at ?? null);
    if (!startedAt) {
      continue;
    }
    const ageMs = now.getTime() - startedAt.getTime();
    if (!Number.isFinite(ageMs) || ageMs <= timeoutMs) {
      continue;
    }
    const ageMinutes = Math.floor(ageMs / 60000);
    console.warn("in_flight_stale", {
      connector_code: connector.connector_code,
      last_run_start: startedAt.toISOString(),
      age_minutes: ageMinutes,
    });
    await updateConnectorRun(connector.id ?? null, {
      last_run_end: now.toISOString(),
      last_run_status: "failed",
      last_run_message: "in_flight_timeout",
    });
    await insertIngestRun({
      connector_id: connector.id ?? null,
      connector_code: connector.connector_code,
      run_started_at: startedAt.toISOString(),
      run_ended_at: now.toISOString(),
      run_status: "failed",
      run_message: "in_flight_timeout",
      last_observed_at: null,
      stations_updated: null,
      observations_upserted: null,
      timeseries_updated: null,
      series_polled: null,
    });
  }
}

async function _reconcileInFlightByLastPolled(
  connectors: ConnectorRow[],
): Promise<void> {
  for (const connector of connectors) {
    if (!connector || connector.last_run_end) {
      continue;
    }
    const startedAt = parseDate(connector.last_run_start ?? null);
    const lastPolled = parseDate(connector.last_polled_at ?? null);
    if (!startedAt || !lastPolled || lastPolled < startedAt) {
      continue;
    }
    await updateConnectorRun(connector.id ?? null, {
      last_run_end: lastPolled.toISOString(),
      last_run_status: "succeeded",
      last_run_message: "polled_reconciled",
    });
  }
}

async function reconcileInFlightByLatestRun(
  connectors: ConnectorRow[],
  latestRuns: Map<string, IngestRunRow>,
): Promise<void> {
  for (const connector of connectors) {
    if (!connector || connector.last_run_end) {
      continue;
    }
    const latestRun = latestRuns.get(connector.connector_code ?? "");
    if (!latestRun || !latestRun.run_ended_at) {
      continue;
    }
    await updateConnectorRun(connector.id ?? null, {
      last_run_end: latestRun.run_ended_at,
      last_run_status: latestRun.run_status ?? "succeeded",
      last_run_message: "ingest_runs_reconciled",
    });
  }
}

function selectDueConnectors(
  dueCandidates: DispatchCandidate[],
  maxRuns: number,
): {
  selected: DispatchCandidate[];
  skipped: {
    connectorCode: string;
    connector: ConnectorRow | null;
  }[];
} {
  if (!dueCandidates.length) {
    return { selected: [], skipped: [] };
  }
  const sorted = [...dueCandidates].sort((a, b) => {
    if (a.lastPolledMs !== b.lastPolledMs) {
      return a.lastPolledMs - b.lastPolledMs;
    }
    return a.connectorCode.localeCompare(b.connectorCode);
  });
  const limit = Math.max(1, Math.floor(maxRuns));
  return {
    selected: sorted.slice(0, limit),
    skipped: sorted.slice(limit).map((item) => ({
      connectorCode: item.connectorCode,
      connector: item.connector,
    })),
  };
}

async function postgrestRequest<T>(
  method: string,
  table: string,
  params?: Record<string, string>,
  body?: unknown,
  schema?: string,
): Promise<{ data: T | null; error: { message: string } | null }> {
  if (!REST_BASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return {
      data: null,
      error: { message: "Missing REST_BASE_URL or SUPABASE_SERVICE_ROLE_KEY." },
    };
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
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = resp.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await resp.json().catch(() => null)
    : await resp.text().catch(() => null);
  if (!resp.ok) {
    const message = payload?.message || payload?.error_description ||
      payload?.error || resp.statusText;
    return { data: null, error: { message: String(message) } };
  }
  return { data: payload as T, error: null };
}

async function dispatchClaim(
  connectorCode: string,
  runStartedAt: string,
  timeoutMinutes: number,
): Promise<boolean> {
  const { data, error } = await postgrestRequest<
    Array<{
      claimed: boolean;
      connector_id: number | null;
      last_run_start: string | null;
      last_run_end: string | null;
    }>
  >(
    "POST",
    "rpc/uk_aq_rpc_dispatch_claim",
    undefined,
    {
      p_connector_code: connectorCode,
      p_run_started_at: runStartedAt,
      p_timeout_minutes: timeoutMinutes,
    },
    "uk_aq_public",
  );
  if (error) {
    console.warn("dispatch claim failed:", error.message);
    return false;
  }
  if (!Array.isArray(data) || data.length === 0) {
    return false;
  }
  return Boolean(data[0]?.claimed);
}

async function enqueueDispatchQueue(connectorCodes: string[]): Promise<number> {
  if (!connectorCodes.length) {
    return 0;
  }
  const entries = connectorCodes.map((connectorCode) => ({
    connector_code: connectorCode,
    payload: { connector_code: connectorCode },
    next_attempt_at: new Date().toISOString(),
  }));
  const { data, error } = await postgrestRpcRequest<
    Array<{ rows_enqueued: number }>
  >(
    "uk_aq_dispatch_queue_enqueue",
    { p_entries: entries },
  );
  if (error) {
    throw new Error(`Dispatch queue enqueue failed: ${error.message}`);
  }
  return Number(data?.[0]?.rows_enqueued ?? 0);
}

async function claimDispatchQueueJobs(
  batchLimit: number,
): Promise<DispatchQueueClaimRow[]> {
  const { data, error } = await postgrestRpcRequest<DispatchQueueClaimRow[]>(
    "uk_aq_dispatch_queue_claim",
    {
      p_batch_limit: Math.max(1, Math.floor(batchLimit)),
      p_lease_seconds: DISPATCH_QUEUE_LEASE_SECONDS,
    },
  );
  if (error) {
    throw new Error(`Dispatch queue claim failed: ${error.message}`);
  }
  return Array.isArray(data) ? data : [];
}

async function resolveDispatchQueueJobs(
  resolutions: Array<{
    id: number;
    ok: boolean;
    error?: string;
    retry_in_seconds?: number;
  }>,
): Promise<number> {
  if (!resolutions.length) {
    return 0;
  }
  const { data, error } = await postgrestRpcRequest<
    Array<{ rows_resolved: number }>
  >(
    "uk_aq_dispatch_queue_resolve",
    { p_resolutions: resolutions },
  );
  if (error) {
    throw new Error(`Dispatch queue resolve failed: ${error.message}`);
  }
  return Number(data?.[0]?.rows_resolved ?? 0);
}

async function updateConnectorRun(
  connectorId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!connectorId) {
    return;
  }
  const { error } = await postgrestRequest(
    "PATCH",
    "connectors",
    { id: `eq.${connectorId}` },
    payload,
  );
  if (error) {
    console.warn("connectors update failed:", error.message);
  }
}

async function insertIngestRun(row: Record<string, unknown>): Promise<void> {
  const { error } = await postgrestRequest(
    "POST",
    "uk_aq_ingest_runs",
    undefined,
    row,
  );
  if (error) {
    console.warn("uk_aq_ingest_runs insert failed:", error.message);
  }
}

async function logError(entry: ErrorLogEntry): Promise<void> {
  const row = {
    id: crypto.randomUUID(),
    source: "edge",
    severity: entry.severity,
    message: entry.message,
    stack: null,
    context: entry.context ?? null,
    connector_id: entry.connector_id ?? null,
    station_id: null,
    timeseries_id: null,
  };
  const { error } = await postgrestRequest(
    "POST",
    "error_logs",
    undefined,
    row,
    UK_AQ_RAW_SCHEMA,
  );
  if (error) {
    console.warn("error_logs insert failed:", error.message);
  }
}

async function postgrestRpcRequest<T>(
  fn: string,
  body: Record<string, unknown>,
): Promise<{ data: T | null; error: { message: string } | null }> {
  return await postgrestRequest<T>(
    "POST",
    `rpc/${fn}`,
    undefined,
    body,
    UK_AQ_CORE_SCHEMA,
  );
}

async function publicRpcRequest<T>(
  fn: string,
  args?: Record<string, unknown>,
): Promise<{ data: T | null; error: { message: string } | null }> {
  return await postgrestRequest<T>(
    "POST",
    `rpc/${fn}`,
    undefined,
    args ?? {},
    "uk_aq_public",
  );
}

function emptyHistoryOutboxDrainSummary(): HistoryOutboxDrainSummary {
  return {
    batches: 0,
    max_batches: HISTORY_OUTBOX_DISPATCH_MAX_FLUSHES,
    claimed: 0,
    delivered: 0,
    failed: 0,
    receipts_upserted: 0,
    rows_resolved: 0,
    warnings: [],
  };
}

async function drainHistoryOutboxFromDispatcher(
  dispatchStartedAtMs: number,
): Promise<
  HistoryOutboxDrainSummary
> {
  const summary = emptyHistoryOutboxDrainSummary();
  for (let idx = 0; idx < HISTORY_OUTBOX_DISPATCH_MAX_FLUSHES; idx += 1) {
    if (!isDispatchBudgetRemaining(dispatchStartedAtMs)) {
      summary.stopped_early = true;
      summary.stop_reason = "dispatch_time_budget";
      break;
    }
    const batchWarnings: string[] = [];
    const stats = await flushHistoryOutbox(publicRpcRequest, (message) => {
      batchWarnings.push(message);
      console.warn("history_outbox_flush_warning", { message });
    });
    summary.batches += 1;
    summary.claimed += stats.claimed;
    summary.delivered += stats.delivered;
    summary.failed += stats.failed;
    summary.receipts_upserted += stats.receipts_upserted;
    summary.rows_resolved += stats.rows_resolved;
    if (batchWarnings.length) {
      summary.warnings.push(...batchWarnings);
    }
    if (stats.claimed === 0) {
      break;
    }
    // Avoid repeatedly hammering the same failing payloads in a single run.
    if (stats.failed > 0 && stats.delivered === 0) {
      break;
    }
  }
  return summary;
}

async function loadConnectorConfigs(): Promise<ConnectorRow[]> {
  const { data, error } = await postgrestRequest<ConnectorRow[]>(
    "GET",
    "connectors",
    {
      select:
        "id,connector_code,poll_enabled,poll_interval_minutes,poll_window_hours,poll_timeseries_batch_size,last_polled_at,last_run_start,last_run_end,last_run_status",
      connector_code: postgrestIn(TARGET_CONNECTORS),
      limit: "20",
    },
  );
  if (error) {
    throw new Error(`Failed to load connectors: ${error.message}`);
  }
  return data ?? [];
}

async function loadLatestIngestRuns(): Promise<Map<string, IngestRunRow>> {
  const { data, error } = await postgrestRequest<IngestRunRow[]>(
    "GET",
    "uk_aq_ingest_runs",
    {
      select:
        "connector_id,connector_code,run_started_at,run_ended_at,run_status",
      connector_code: postgrestIn(TARGET_CONNECTORS),
      order: "run_started_at.desc",
      limit: "200",
    },
  );
  if (error) {
    throw new Error(`Failed to load uk_aq_ingest_runs: ${error.message}`);
  }
  const latest = new Map<string, IngestRunRow>();
  for (const row of data ?? []) {
    const code = row.connector_code ?? "";
    if (!code || latest.has(code)) {
      continue;
    }
    latest.set(code, row);
  }
  return latest;
}
async function loadStationRefs(
  fn: string,
  params: { batchLimit: number; activeOnly?: boolean; staleLimit?: number },
): Promise<string[]> {
  const payload: Record<string, unknown> = { batch_limit: params.batchLimit };
  if (params.activeOnly !== undefined) {
    payload.active_only = params.activeOnly;
  }
  if (params.staleLimit !== undefined) {
    payload.stale_limit = params.staleLimit;
  }
  const { data, error } = await postgrestRpcRequest<string[] | null>(
    fn,
    payload,
  );
  if (error) {
    throw new Error(`Failed to load station refs via ${fn}: ${error.message}`);
  }
  if (!data || !Array.isArray(data)) {
    return [];
  }
  return data.map((ref) => String(ref).trim().toUpperCase()).filter(Boolean);
}

async function loadUkAirSosTimeseriesIds(
  limit: number,
): Promise<string[]> {
  const { data, error } = await postgrestRpcRequest<string[] | null>(
    "uk_air_sos_select_timeseries_ids",
    { batch_limit: limit },
  );
  if (error) {
    throw new Error(
      `Failed to load uk_air_sos timeseries ids: ${error.message}`,
    );
  }
  if (!data || !Array.isArray(data)) {
    return [];
  }
  return data.map((value) => String(value));
}

async function callEdgeFunction(
  path: string,
  payload: Record<string, unknown>,
  dispatchStartedAtMs: number,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  if (!SUPABASE_URL) {
    throw new Error("Missing SUPABASE_URL.");
  }
  const authKey = SB_ANON_JWT || SUPABASE_SERVICE_ROLE_KEY;
  if (!authKey) {
    throw new Error("Missing SB_ANON_JWT or SUPABASE_SERVICE_ROLE_KEY.");
  }
  const url = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authKey}`,
    apikey: authKey,
  };
  if (SB_UK_AQ_CRON_SECRET) {
    headers["X-Cron-Secret"] = SB_UK_AQ_CRON_SECRET;
  }
  const remainingMs = Math.max(
    0,
    DISPATCH_TIME_BUDGET_MS - (Date.now() - dispatchStartedAtMs) -
      DISPATCH_EFFECTIVE_SHUTDOWN_BUFFER_MS,
  );
  if (remainingMs < MIN_EDGE_CALL_TIMEOUT_MS) {
    return {
      ok: false,
      status: 503,
      body: {
        error: "dispatch_time_budget",
        remaining_ms: remainingMs,
      },
    };
  }
  const timeoutMs = Math.max(
    MIN_EDGE_CALL_TIMEOUT_MS,
    Math.min(DISPATCH_EDGE_CALL_TIMEOUT_MS, Math.floor(remainingMs)),
  );
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  console.log("dispatch_edge_function", {
    path,
    timeout_ms: timeoutMs,
    remaining_budget_ms: remainingMs,
    has_cron_secret: Boolean(SB_UK_AQ_CRON_SECRET),
    cron_secret_length: SB_UK_AQ_CRON_SECRET ? SB_UK_AQ_CRON_SECRET.length : 0,
    auth_key_type: SB_ANON_JWT ? "anon" : "service_role",
    auth_key_length: authKey.length,
  });
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        ok: false,
        status: 504,
        body: {
          error: "dispatch_edge_timeout",
          timeout_ms: timeoutMs,
        },
      };
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
  const contentType = resp.headers.get("content-type") ?? "";
  const payloadBody = contentType.includes("application/json")
    ? await resp.json().catch(() => null)
    : await resp.text().catch(() => null);
  return { ok: resp.ok, status: resp.status, body: payloadBody };
}

function windowHoursToDays(windowHours: number): number {
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(windowHours / 24));
}

function isDispatchBudgetRemaining(dispatchStartedAtMs: number): boolean {
  const elapsed = Date.now() - dispatchStartedAtMs;
  return elapsed + DISPATCH_EFFECTIVE_SHUTDOWN_BUFFER_MS <
    DISPATCH_TIME_BUDGET_MS;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const authResponse = requireCronSecret(req);
  if (authResponse) {
    return authResponse;
  }
  let requestPayload: Record<string, unknown> = {};
  try {
    requestPayload = await req.json();
  } catch {
    requestPayload = {};
  }
  const dispatchModeRaw = String(
    requestPayload.mode ?? requestPayload.dispatch_mode ?? "enqueue",
  ).trim().toLowerCase();
  const dispatchMode: DispatchMode = dispatchModeRaw === "run_queue"
    ? "run_queue"
    : dispatchModeRaw === "legacy"
    ? "legacy"
    : "enqueue";
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({
      error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.",
    }, 500);
  }

  console.log("uk_aq_dispatch_polls cron secret", {
    has_cron_secret: Boolean(SB_UK_AQ_CRON_SECRET),
    cron_secret_length: SB_UK_AQ_CRON_SECRET ? SB_UK_AQ_CRON_SECRET.length : 0,
    dispatch_mode: dispatchMode,
  });
  if (DISPATCH_EFFECTIVE_SHUTDOWN_BUFFER_MS !== DISPATCH_SHUTDOWN_BUFFER_MS) {
    console.warn("dispatch_shutdown_buffer_clamped", {
      dispatch_time_budget_ms: DISPATCH_TIME_BUDGET_MS,
      dispatch_shutdown_buffer_ms: DISPATCH_SHUTDOWN_BUFFER_MS,
      effective_shutdown_buffer_ms: DISPATCH_EFFECTIVE_SHUTDOWN_BUFFER_MS,
      min_edge_call_timeout_ms: MIN_EDGE_CALL_TIMEOUT_MS,
    });
  }

  const dispatchStartedAtMs = Date.now();
  const now = new Date();
  const historyOutbox = dispatchMode === "run_queue"
    ? emptyHistoryOutboxDrainSummary()
    : await drainHistoryOutboxFromDispatcher(
      dispatchStartedAtMs,
    ).catch((
      error,
    ) => {
      const summary = emptyHistoryOutboxDrainSummary();
      summary.error = error instanceof Error ? error.message : String(error);
      console.warn("history_outbox_flush_failed", {
        error: summary.error,
      });
      return summary;
    });
  const results = new Map<string, DispatchResult>();
  let connectors: ConnectorRow[] = [];
  let latestRuns = new Map<string, IngestRunRow>();
  try {
    connectors = await loadConnectorConfigs();
    latestRuns = await loadLatestIngestRuns();
  } catch (error) {
    await logError({
      severity: "error",
      message: error instanceof Error ? error.message : String(error),
      context: { component: "uk_aq_dispatch_polls", step: "load_connectors" },
    });
    return jsonResponse({
      error: error instanceof Error ? error.message : String(error),
      history_outbox: historyOutbox,
    }, 500);
  }

  await reconcileInFlightByLatestRun(connectors, latestRuns);
  await settleStaleInFlight(connectors, latestRuns, now);

  const settings = normalizeDispatcherSettings(await loadDispatcherSettings());

  const connectorMap = new Map(
    connectors.map((row) => [row.connector_code, row]),
  );
  const inFlight = findRecentInFlightConnector(latestRuns, now);
  if (dispatchMode !== "run_queue" && inFlight && !settings.dispatcher_parallel_ingest) {
    for (const connectorCode of TARGET_CONNECTORS) {
      results.set(connectorCode, {
        connector_code: connectorCode,
        status: "skipped",
        detail: "in_flight",
      });
    }
    return jsonResponse({
      checked_at: now.toISOString(),
      in_flight: inFlight,
      history_outbox: historyOutbox,
      results: TARGET_CONNECTORS.map((code) => results.get(code)),
    });
  }

  const dueCandidates: DispatchCandidate[] = [];
  let selected: DispatchCandidate[] = [];
  let skipped: {
    connectorCode: string;
    connector: ConnectorRow | null;
  }[] = [];
  let queueClaimRows: DispatchQueueClaimRow[] = [];
  let queueEnqueued = 0;

  if (dispatchMode === "run_queue") {
    const runQueueClaimLimit = resolveRunQueueClaimLimit(settings);
    try {
      queueClaimRows = await claimDispatchQueueJobs(runQueueClaimLimit);
    } catch (error) {
      await logError({
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        context: {
          component: "uk_aq_dispatch_polls",
          step: "queue_claim",
        },
      });
      return jsonResponse({
        error: error instanceof Error ? error.message : String(error),
        dispatch_mode: dispatchMode,
        history_outbox: historyOutbox,
      }, 500);
    }

    if (!queueClaimRows.length) {
      for (const connectorCode of TARGET_CONNECTORS) {
        results.set(connectorCode, {
          connector_code: connectorCode,
          status: "skipped",
          detail: "queue_empty",
        });
      }
      return jsonResponse({
        checked_at: now.toISOString(),
        dispatch_mode: dispatchMode,
        dispatcher_settings: settings,
        history_outbox: historyOutbox,
        queue: { claimed: 0, enqueued: 0, resolved: 0 },
        results: TARGET_CONNECTORS.map((code) => results.get(code)),
      });
    }

    const missingConnectorResolutions: Array<{ id: number; ok: boolean; error: string }> = [];
    for (const row of queueClaimRows) {
      const connectorCode = String(row.connector_code ?? "").trim();
      const connector = connectorMap.get(connectorCode) ?? null;
      if (!connector || !TARGET_CONNECTORS.includes(connectorCode)) {
        missingConnectorResolutions.push({
          id: Number(row.id),
          ok: true,
          error: "queue_entry_unknown_connector",
        });
        continue;
      }
      if (connector.poll_enabled !== true) {
        missingConnectorResolutions.push({
          id: Number(row.id),
          ok: true,
          error: "queue_entry_disabled_connector",
        });
        continue;
      }
      selected.push({
        connectorCode,
        connector,
        lastPolledMs: getLastPolledMs(connector),
        queueJobId: Number(row.id),
      });
    }
    if (missingConnectorResolutions.length) {
      try {
        await resolveDispatchQueueJobs(missingConnectorResolutions);
      } catch (error) {
        console.warn("dispatch queue resolve failed for unknown connectors", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!selected.length) {
      for (const connectorCode of TARGET_CONNECTORS) {
        results.set(connectorCode, {
          connector_code: connectorCode,
          status: "skipped",
          detail: "queue_empty",
        });
      }
      return jsonResponse({
        checked_at: now.toISOString(),
        dispatch_mode: dispatchMode,
        dispatcher_settings: settings,
        history_outbox: historyOutbox,
        queue: {
          claimed: queueClaimRows.length,
          enqueued: 0,
          resolved: missingConnectorResolutions.length,
        },
        results: TARGET_CONNECTORS.map((code) => results.get(code)),
      });
    }
  } else {
    for (const connectorCode of TARGET_CONNECTORS) {
      const connector = connectorMap.get(connectorCode) ?? null;
      const latestRun = latestRuns.get(connectorCode) ?? null;
      if (isConnectorInFlight(connector, latestRun, now)) {
        results.set(connectorCode, {
          connector_code: connectorCode,
          status: "skipped",
          detail: "in_flight",
        });
        continue;
      }
      if (!isDue(connector, connectorCode, now)) {
        results.set(connectorCode, {
          connector_code: connectorCode,
          status: "skipped",
          detail: "not_due",
        });
        continue;
      }
      dueCandidates.push({
        connectorCode,
        connector,
        lastPolledMs: getLastPolledMs(connector),
      });
    }

    if (!dueCandidates.length) {
      return jsonResponse({
        checked_at: now.toISOString(),
        dispatch_mode: dispatchMode,
        history_outbox: historyOutbox,
        results: TARGET_CONNECTORS.map((code) => results.get(code)),
      });
    }

    const selectedCandidates = selectDueConnectors(
      dueCandidates,
      settings.dispatcher_parallel_ingest
        ? settings.max_runs_per_dispatch_call
        : 1,
    );
    selected = selectedCandidates.selected;
    skipped = selectedCandidates.skipped;
  }

  console.log("dispatch_selection", {
    dispatch_mode: dispatchMode,
    max_runs: settings.dispatcher_parallel_ingest
      ? settings.max_runs_per_dispatch_call
      : 1,
    run_queue_claim_limit: dispatchMode === "run_queue"
      ? resolveRunQueueClaimLimit(settings)
      : null,
    due_candidates: dueCandidates.map((item) => ({
      connector_code: item.connectorCode,
      last_polled_ms: item.lastPolledMs,
    })),
    queue_claimed: queueClaimRows.map((item) => ({
      id: item.id,
      connector_code: item.connector_code,
      attempts: item.attempts,
    })),
    selected: selected.map((item) => item.connectorCode),
    skipped: skipped.map((item) => item.connectorCode),
  });

  for (const candidate of skipped) {
    results.set(candidate.connectorCode, {
      connector_code: candidate.connectorCode,
      status: "skipped",
      detail: "not_selected",
    });
  }
  if (dispatchMode === "run_queue") {
    const selectedSet = new Set(selected.map((item) => item.connectorCode));
    for (const connectorCode of TARGET_CONNECTORS) {
      if (selectedSet.has(connectorCode) || results.has(connectorCode)) {
        continue;
      }
      results.set(connectorCode, {
        connector_code: connectorCode,
        status: "skipped",
        detail: "queue_not_selected",
      });
    }
  }

  if (dispatchMode === "enqueue") {
    try {
      queueEnqueued = await enqueueDispatchQueue(
        selected.map((item) => item.connectorCode),
      );
    } catch (error) {
      await logError({
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        context: {
          component: "uk_aq_dispatch_polls",
          step: "queue_enqueue",
          selected: selected.map((item) => item.connectorCode),
        },
      });
      return jsonResponse({
        error: error instanceof Error ? error.message : String(error),
        dispatch_mode: dispatchMode,
        history_outbox: historyOutbox,
      }, 500);
    }
    for (const item of selected) {
      results.set(item.connectorCode, {
        connector_code: item.connectorCode,
        status: "queued",
        detail: "queue_enqueued",
      });
    }
    return jsonResponse({
      checked_at: now.toISOString(),
      dispatch_mode: dispatchMode,
      dispatcher_settings: settings,
      history_outbox: historyOutbox,
      queue: {
        enqueued: queueEnqueued,
        selected: selected.map((item) => item.connectorCode),
      },
      results: TARGET_CONNECTORS.map((code) => results.get(code)),
    });
  }

  let budgetBreakIndex: number | null = null;
  for (let selectedIndex = 0; selectedIndex < selected.length; selectedIndex += 1) {
    if (!isDispatchBudgetRemaining(dispatchStartedAtMs)) {
      budgetBreakIndex = selectedIndex;
      break;
    }
    const candidate = selected[selectedIndex];
    const connectorCode = candidate.connectorCode;
    const connector = candidate.connector;
    const queueJobId = candidate.queueJobId;
    const runStart = new Date();
    const claimed = await dispatchClaim(
      connectorCode,
      runStart.toISOString(),
      IN_FLIGHT_TIMEOUT_MINUTES,
    );
    if (!claimed) {
      console.warn("dispatch_claim_failed", { connector_code: connectorCode });
      results.set(connectorCode, {
        connector_code: connectorCode,
        status: "skipped",
        detail: "in_flight_claimed",
      });
      if (queueJobId !== undefined) {
        try {
          await resolveDispatchQueueJobs([
            {
              id: queueJobId,
              ok: false,
              error: "in_flight_claimed",
              retry_in_seconds: 120,
            },
          ]);
        } catch (error) {
          console.warn("dispatch queue resolve failed", {
            id: queueJobId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      continue;
    }
    let runStatus = "failed";
    let runMessage = "";
    let lastResponse: { status: number; body: unknown } | null = null;
    const runScope: RunScope = {};

    try {
      if (connectorCode === "uk_air_sos") {
        const windowHours = getWindowHours(connector, connectorCode);
        const timeseriesLimit = getTimeseriesLimit(connector);
        let timeseriesIds: string[] = [];
        if (timeseriesLimit) {
          timeseriesIds = await loadUkAirSosTimeseriesIds(timeseriesLimit);
        }
        runScope.timeseriesIds = timeseriesIds;
        const payload: Record<string, unknown> = {
          connector_code: connectorCode,
          window_hours: windowHours,
        };
        if (timeseriesLimit) {
          payload.timeseries_limit = timeseriesLimit;
        }
        if (timeseriesIds.length) {
          payload.timeseries_ids = timeseriesIds;
        }
        const resp = await callEdgeFunction(
          "ingest_uk_air_sos",
          payload,
          dispatchStartedAtMs,
        );
        lastResponse = { status: resp.status, body: resp.body };
        if (!resp.ok) {
          runStatus = "failed";
          runMessage = `HTTP ${resp.status}`;
          await logError({
            severity: "error",
            message: "ingest_uk_air_sos dispatch failed",
            connector_id: connector?.id ?? null,
            context: {
              connector_code: connectorCode,
              response_status: resp.status,
              response_body: resp.body,
            },
          });
        } else {
          runStatus = "succeeded";
          runMessage = "dispatched";
        }
        results.set(connectorCode, {
          connector_code: connectorCode,
          status: resp.ok ? "triggered" : "error",
          response_status: resp.status,
          detail: resp.ok ? "dispatched" : JSON.stringify(resp.body),
        });
      } else if (connectorCode === "sensorcommunity") {
        const resp = await callEdgeFunction(
          "ingest_sensorcommunity",
          {
            connector_code: connectorCode,
            country: "GB",
          },
          dispatchStartedAtMs,
        );
        lastResponse = { status: resp.status, body: resp.body };
        if (!resp.ok) {
          runStatus = "failed";
          runMessage = `HTTP ${resp.status}`;
          await logError({
            severity: "error",
            message: "ingest_sensorcommunity dispatch failed",
            connector_id: connector?.id ?? null,
            context: {
              connector_code: connectorCode,
              response_status: resp.status,
              response_body: resp.body,
            },
          });
        } else {
          runStatus = "succeeded";
          runMessage = "dispatched";
        }
        results.set(connectorCode, {
          connector_code: connectorCode,
          status: resp.ok ? "triggered" : "error",
          response_status: resp.status,
          detail: resp.ok ? "dispatched" : JSON.stringify(resp.body),
        });
      } else if (connectorCode === "openaq") {
        const windowHours = getWindowHours(connector, connectorCode);
        const batchSize = getBatchLimit(connector, connectorCode);
        const resp = await callEdgeFunction(
          "ingest_openaq",
          {
            connector_code: connectorCode,
            window_hours: windowHours,
            batch_size: batchSize,
          },
          dispatchStartedAtMs,
        );
        lastResponse = { status: resp.status, body: resp.body };
        if (!resp.ok) {
          runStatus = "failed";
          runMessage = `HTTP ${resp.status}`;
          await logError({
            severity: "error",
            message: "ingest_openaq dispatch failed",
            connector_id: connector?.id ?? null,
            context: {
              connector_code: connectorCode,
              response_status: resp.status,
              response_body: resp.body,
            },
          });
        } else {
          runStatus = "succeeded";
          runMessage = "dispatched";
        }
        results.set(connectorCode, {
          connector_code: connectorCode,
          status: resp.ok ? "triggered" : "error",
          response_status: resp.status,
          detail: resp.ok ? "dispatched" : JSON.stringify(resp.body),
        });
      } else if (connectorCode === "breathelondon") {
        const batchLimit = getBatchLimit(connector, connectorCode);
        const stationRefs = await loadStationRefs(
          "breathelondon_select_station_refs",
          {
            batchLimit,
            staleLimit: 4,
          },
        );
        console.log("breathelondon_station_refs", {
          count: stationRefs.length,
          batch_limit: batchLimit,
        });
        runScope.stationRefs = stationRefs;
        if (!stationRefs.length) {
          runStatus = "skipped";
          runMessage = "no_station_refs";
          results.set(connectorCode, {
            connector_code: connectorCode,
            status: "skipped",
            detail: "no_station_refs",
          });
        } else {
          const windowHours = getWindowHours(connector, connectorCode);
          const resp = await callEdgeFunction(
            "ingest_breathelondon",
            {
              connector_code: connectorCode,
              service_ref: connectorCode,
              station_refs: stationRefs,
              skip_stations: true,
              active_only: true,
              initial_days: 2,
              window_hours: windowHours,
            },
            dispatchStartedAtMs,
          );
          lastResponse = { status: resp.status, body: resp.body };
          if (!resp.ok) {
            runStatus = "failed";
            runMessage = `HTTP ${resp.status}`;
            await logError({
              severity: "error",
              message: "ingest_breathelondon dispatch failed",
              connector_id: connector?.id ?? null,
              context: {
                connector_code: connectorCode,
                response_status: resp.status,
                response_body: resp.body,
              },
            });
          } else {
            runStatus = "succeeded";
            runMessage = "dispatched";
          }
          results.set(connectorCode, {
            connector_code: connectorCode,
            status: resp.ok ? "triggered" : "error",
            response_status: resp.status,
            detail: resp.ok ? "dispatched" : JSON.stringify(resp.body),
          });
        }
      } else if (connectorCode === "erg_laqn") {
        const batchLimit = getBatchLimit(connector, connectorCode);
        const stationRefs = await loadStationRefs(
          "erg_laqn_select_station_refs",
          {
            batchLimit,
            activeOnly: true,
          },
        );
        runScope.stationRefs = stationRefs;
        if (!stationRefs.length) {
          runStatus = "skipped";
          runMessage = "no_station_refs";
          results.set(connectorCode, {
            connector_code: connectorCode,
            status: "skipped",
            detail: "no_station_refs",
          });
        } else {
          const windowHours = getWindowHours(connector, connectorCode);
          const resp = await callEdgeFunction(
            "ingest_erg_laqn",
            {
              connector_code: connectorCode,
              service_ref: connectorCode,
              group: "London",
              days: windowHoursToDays(windowHours),
              start_from_latest: true,
              station_refs: stationRefs,
            },
            dispatchStartedAtMs,
          );
          lastResponse = { status: resp.status, body: resp.body };
          if (!resp.ok) {
            runStatus = "failed";
            runMessage = `HTTP ${resp.status}`;
            await logError({
              severity: "error",
              message: "ingest_erg_laqn dispatch failed",
              connector_id: connector?.id ?? null,
              context: {
                connector_code: connectorCode,
                response_status: resp.status,
                response_body: resp.body,
              },
            });
          } else {
            runStatus = "succeeded";
            runMessage = "dispatched";
          }
          results.set(connectorCode, {
            connector_code: connectorCode,
            status: resp.ok ? "triggered" : "error",
            response_status: resp.status,
            detail: resp.ok ? "dispatched" : JSON.stringify(resp.body),
          });
        }
      } else {
        runStatus = "skipped";
        runMessage = "unsupported_connector";
        results.set(connectorCode, {
          connector_code: connectorCode,
          status: "skipped",
          detail: "unsupported_connector",
        });
      }
    } catch (error) {
      runStatus = "failed";
      runMessage = error instanceof Error ? error.message : String(error);
      await logError({
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        connector_id: connector?.id ?? null,
        context: { connector_code: connectorCode, step: "dispatch" },
      });
      results.set(connectorCode, {
        connector_code: connectorCode,
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      const runEnd = new Date();
      await updateConnectorRun(connector?.id ?? null, {
        last_run_start: runStart.toISOString(),
        last_run_end: runEnd.toISOString(),
        last_run_status: runStatus,
        last_run_message: runMessage,
        last_polled_at: runEnd.toISOString(),
      });
      if (connectorCode) {
        let lastObservedAt: string | null = null;
        if (lastResponse) {
          try {
            lastObservedAt = await resolveLastObservedAt(
              connector?.id ?? null,
              runScope,
            );
          } catch (error) {
            console.warn("Failed to resolve last_observed_at.", {
              connector_code: connectorCode,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const metrics = extractRunMetrics(
          connectorCode,
          lastResponse?.body ?? null,
        );
        await insertIngestRun({
          connector_id: connector?.id ?? null,
          connector_code: connectorCode,
          run_started_at: runStart.toISOString(),
          run_ended_at: runEnd.toISOString(),
          run_status: runStatus,
          run_message: runMessage || null,
          last_observed_at: lastObservedAt,
          stations_updated: metrics.stations_updated,
          observations_upserted: metrics.observations_upserted,
          timeseries_updated: metrics.timeseries_updated,
          series_polled: metrics.series_polled,
          response_status: lastResponse?.status ?? null,
          response_payload: lastResponse?.body ?? null,
        });
      }
      if (queueJobId !== undefined) {
        const ok = runStatus === "succeeded" || runStatus === "skipped";
        try {
          await resolveDispatchQueueJobs([
            {
              id: queueJobId,
              ok,
              error: ok ? undefined : runMessage || "dispatch_failed",
              retry_in_seconds: ok ? undefined : 120,
            },
          ]);
        } catch (error) {
          console.warn("dispatch queue resolve failed", {
            id: queueJobId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
  if (budgetBreakIndex !== null) {
    for (let idx = budgetBreakIndex; idx < selected.length; idx += 1) {
      const connectorCode = selected[idx].connectorCode;
      const queueJobId = selected[idx].queueJobId;
      if (results.has(connectorCode)) {
        continue;
      }
      results.set(connectorCode, {
        connector_code: connectorCode,
        status: "skipped",
        detail: "dispatch_time_budget",
      });
      if (queueJobId !== undefined) {
        try {
          await resolveDispatchQueueJobs([
            {
              id: queueJobId,
              ok: false,
              error: "dispatch_time_budget",
              retry_in_seconds: 30,
            },
          ]);
        } catch (error) {
          console.warn("dispatch queue resolve failed", {
            id: queueJobId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  return jsonResponse({
    checked_at: now.toISOString(),
    dispatch_mode: dispatchMode,
    dispatcher_settings: settings,
    history_outbox: historyOutbox,
    queue: {
      claimed: queueClaimRows.length,
      enqueued: queueEnqueued,
    },
    results: TARGET_CONNECTORS.map((code) => results.get(code)),
  });
});
