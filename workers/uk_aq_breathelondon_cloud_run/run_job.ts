const CONNECTOR_CODE =
  (Deno.env.get("BREATHELONDON_CONNECTOR_CODE") || "breathelondon").trim();
const SCHEDULER_BACKEND_SUPABASE_FUNCTION = "supabase_function";
const SCHEDULER_BACKEND_GOOGLE_CLOUD_RUN = "google_cloud_run";
const DEFAULT_INTERVAL_MINUTES = parsePositiveInt(
  Deno.env.get("BREATHELONDON_DEFAULT_INTERVAL_MINUTES"),
  60,
);
const IN_FLIGHT_TIMEOUT_MINUTES = parsePositiveInt(
  Deno.env.get("BREATHELONDON_IN_FLIGHT_TIMEOUT_MINUTES"),
  30,
);
const CLAIM_TIMEOUT_MINUTES = parsePositiveInt(
  Deno.env.get("BREATHELONDON_CLAIM_TIMEOUT_MINUTES"),
  30,
);
const DEFAULT_WINDOW_HOURS = parsePositiveInt(
  Deno.env.get("BREATHELONDON_DEFAULT_WINDOW_HOURS"),
  6,
);
const DEFAULT_BATCH_LIMIT = parsePositiveInt(
  Deno.env.get("BREATHELONDON_DEFAULT_BATCH_LIMIT"),
  10,
);
const DEFAULT_STALE_LIMIT = parsePositiveInt(
  Deno.env.get("BREATHELONDON_STALE_LIMIT"),
  4,
);
const PORT = parsePositiveInt(
  Deno.env.get("BREATHELONDON_LOCAL_PORT") || Deno.env.get("PORT"),
  8000,
);
const REQUEST_PAYLOAD_RAW = (Deno.env.get("BREATHELONDON_REQUEST_PAYLOAD") ||
  "{}").trim();
const REQUEST_PAYLOAD_OVERRIDES = parseRequestPayload(REQUEST_PAYLOAD_RAW);
const CRON_SECRET = (Deno.env.get("SB_UK_AQ_CRON_SECRET") || "").trim();

const SUPABASE_URL = requiredEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const UK_AQ_CORE_SCHEMA = (Deno.env.get("UK_AQ_CORE_SCHEMA") || "uk_aq_core")
  .trim();
const UK_AQ_RAW_SCHEMA = (Deno.env.get("UK_AQ_RAW_SCHEMA") || "uk_aq_raw")
  .trim();
const REST_BASE_URL = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1`;

type IngestResponse = {
  ok: boolean;
  status: number;
  body: unknown;
  raw: string;
};
type ConnectorConfig = {
  id: unknown;
  connector_code: unknown;
  poll_enabled: unknown;
  poll_interval_minutes: unknown;
  poll_window_hours: unknown;
  poll_timeseries_batch_size: unknown;
  scheduler_backend: unknown;
  last_polled_at: unknown;
  last_run_start: unknown;
  last_run_end: unknown;
  last_run_status: unknown;
};

type DispatchClaimRow = {
  claimed: unknown;
  connector_id: unknown;
  last_run_start: unknown;
  last_run_end: unknown;
};

function requiredEnv(name: string): string {
  const value = (Deno.env.get(name) || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw || "");
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function parseBool(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined || raw === null) {
    return fallback;
  }
  const value = String(raw).trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "y", "on"].includes(value);
}

function parseRequestPayload(raw: string): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (_error) {
    throw new Error("BREATHELONDON_REQUEST_PAYLOAD must be valid JSON.");
  }
  const payload = toObject(parsed);
  if (!payload) {
    throw new Error("BREATHELONDON_REQUEST_PAYLOAD must be a JSON object.");
  }
  return payload;
}

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toIntegerOrNull(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.trunc(parsed);
}

function toPositiveIntegerOrNull(value: unknown): number | null {
  const parsed = toIntegerOrNull(value);
  if (parsed === null || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseTimestamp(value: unknown): Date | null {
  const text = toStringOrNull(value);
  if (!text) {
    return null;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function evaluateDue(connector: ConnectorConfig | null, now: Date): {
  due: boolean;
  reason: string;
  intervalMinutes: number;
} {
  if (!connector) {
    return {
      due: false,
      reason: "connector_not_found",
      intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    };
  }

  if (connector.poll_enabled !== true) {
    return {
      due: false,
      reason: "poll_disabled",
      intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    };
  }

  const schedulerBackend = toStringOrNull(connector.scheduler_backend) ||
    SCHEDULER_BACKEND_SUPABASE_FUNCTION;
  if (schedulerBackend !== SCHEDULER_BACKEND_GOOGLE_CLOUD_RUN) {
    return {
      due: false,
      reason: "scheduler_backend_not_cloud_run",
      intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    };
  }

  const intervalMinutes = toIntegerOrNull(connector.poll_interval_minutes) ||
    DEFAULT_INTERVAL_MINUTES;

  const runStartedAt = parseTimestamp(connector.last_run_start);
  const runEndedAt = parseTimestamp(connector.last_run_end);
  if (runStartedAt && !runEndedAt) {
    const runningGuardMs =
      Math.max(intervalMinutes, IN_FLIGHT_TIMEOUT_MINUTES) * 60 * 1000;
    const ageMs = now.getTime() - runStartedAt.getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < runningGuardMs) {
      return { due: false, reason: "in_flight", intervalMinutes };
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

function getWindowHours(connector: ConnectorConfig | null): number {
  const value = toPositiveIntegerOrNull(connector?.poll_window_hours);
  if (value !== null) {
    return value;
  }
  return DEFAULT_WINDOW_HOURS;
}

function getBatchLimit(connector: ConnectorConfig | null): number {
  const value = toPositiveIntegerOrNull(connector?.poll_timeseries_batch_size);
  if (value !== null) {
    return value;
  }
  return DEFAULT_BATCH_LIMIT;
}

function postgrestHeaders(
  schema: string,
  write = false,
): Record<string, string> {
  const headers: Record<string, string> = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    Accept: "application/json",
    "Accept-Profile": schema,
  };
  if (write) {
    headers["Content-Type"] = "application/json";
    headers["Content-Profile"] = schema;
  }
  return headers;
}

function withQuery(path: string, query?: Record<string, string>): string {
  const url = new URL(`${REST_BASE_URL}/${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (!value) {
        continue;
      }
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

async function postgrestRequest(
  method: string,
  path: string,
  options: {
    schema?: string;
    query?: Record<string, string>;
    body?: unknown;
    prefer?: string;
  } = {},
): Promise<{ ok: boolean; status: number; text: string; data: unknown }> {
  const schema = options.schema || UK_AQ_CORE_SCHEMA;
  const write = method !== "GET";
  const headers = postgrestHeaders(schema, write);
  if (options.prefer) {
    headers.Prefer = options.prefer;
  }
  const response = await fetch(withQuery(path, options.query), {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { ok: response.ok, status: response.status, text, data };
}

async function loadStationRefs(params: {
  batchLimit: number;
  staleLimit?: number;
}): Promise<string[]> {
  const body: Record<string, unknown> = {
    batch_limit: Math.max(1, Math.trunc(params.batchLimit)),
  };
  if (
    params.staleLimit !== undefined &&
    Number.isFinite(params.staleLimit) &&
    params.staleLimit > 0
  ) {
    body.stale_limit = Math.trunc(params.staleLimit);
  }
  const response = await postgrestRequest(
    "POST",
    "rpc/breathelondon_select_station_refs",
    {
      body,
      schema: UK_AQ_CORE_SCHEMA,
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to load station refs (${response.status}): ${response.text}`,
    );
  }
  if (!Array.isArray(response.data)) {
    return [];
  }
  return response.data
    .map((value) => toStringOrNull(value))
    .filter((value): value is string => Boolean(value));
}

async function buildIngestPayload(
  connector: ConnectorConfig | null,
): Promise<{
  payload: Record<string, unknown>;
  batchLimit: number;
  windowHours: number;
  stationRefs: string[];
}> {
  const payload: Record<string, unknown> = {
    ...REQUEST_PAYLOAD_OVERRIDES,
  };
  const connectorCode = toStringOrNull(payload.connector_code) ||
    CONNECTOR_CODE;
  const serviceRef = toStringOrNull(payload.service_ref) || connectorCode;
  const batchLimit = getBatchLimit(connector);
  const windowHours = getWindowHours(connector);
  const staleLimit = toPositiveIntegerOrNull(payload.stale_limit) ??
    DEFAULT_STALE_LIMIT;
  const stationRefs = await loadStationRefs({
    batchLimit,
    staleLimit,
  });

  payload.connector_code = connectorCode;
  payload.service_ref = serviceRef;
  payload.skip_stations = true;
  payload.active_only = parseBool(
    String(payload.active_only ?? "false"),
    false,
  );
  payload.initial_days = toPositiveIntegerOrNull(payload.initial_days) ?? 2;
  payload.window_hours = windowHours;
  payload.batch_size = batchLimit;
  payload.station_refs = stationRefs;

  return {
    payload,
    batchLimit,
    windowHours,
    stationRefs,
  };
}

function deriveRunSummary(ingestResponse: IngestResponse): {
  runStatus: string;
  runMessage: string;
  payload: Record<string, unknown> | null;
} {
  const payload = toObject(ingestResponse.body);
  const rawStatus = toStringOrNull(payload?.run_status) ||
    (ingestResponse.ok ? "success" : "failed");
  const runStatus = rawStatus === "success" ? "succeeded" : rawStatus;

  let runMessage = toStringOrNull(payload?.run_message);
  if (!runMessage) {
    if (ingestResponse.ok) {
      runMessage = "ingest_breathelondon completed via google_cloud_run";
    } else {
      runMessage =
        `ingest_breathelondon failed with status ${ingestResponse.status}`;
    }
  }

  return { runStatus, runMessage, payload };
}

const STORED_RESPONSE_PAYLOAD_KEYS = [
  "partial",
  "stopped_reason",
  "stations_selected",
  "stations_processed",
  "stations_updated",
  "observations_upserted",
  "observations_rows_input",
  "observations_rows_prepared",
  "observations_rows_deduped_prewrite",
  "history_rows_prepared",
  "history_rows_deduped_prewrite",
  "history_written",
  "history_receipts_upserted",
  "history_enqueued",
  "series_polled",
] as const;

function compactRunResponsePayload(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload) {
    return null;
  }
  const compact: Record<string, unknown> = {};
  for (const key of STORED_RESPONSE_PAYLOAD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      continue;
    }
    const value = payload[key];
    if (value !== undefined) {
      compact[key] = value;
    }
  }
  return Object.keys(compact).length ? compact : null;
}

async function resolveConnectorId(
  payload: Record<string, unknown> | null,
): Promise<number> {
  const payloadConnectorId = toIntegerOrNull(payload?.connector_id);
  if (payloadConnectorId !== null) {
    return payloadConnectorId;
  }

  const response = await postgrestRequest("GET", "connectors", {
    query: {
      connector_code: `eq.${CONNECTOR_CODE}`,
      select: "id",
      limit: "1",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to resolve connector id (${response.status}): ${response.text}`,
    );
  }
  const rows = Array.isArray(response.data) ? response.data : [];
  const id = toIntegerOrNull(toObject(rows[0])?.id);
  if (id === null) {
    throw new Error(`Connector not found: ${CONNECTOR_CODE}`);
  }
  return id;
}

async function loadConnector(): Promise<ConnectorConfig | null> {
  const response = await postgrestRequest("GET", "connectors", {
    query: {
      select:
        "id,connector_code,poll_enabled,poll_interval_minutes,poll_window_hours,poll_timeseries_batch_size,scheduler_backend,last_polled_at,last_run_start,last_run_end,last_run_status",
      connector_code: `eq.${CONNECTOR_CODE}`,
      limit: "1",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to load connector (${response.status}): ${response.text}`,
    );
  }
  const rows = Array.isArray(response.data) ? response.data : [];
  const row = toObject(rows[0]);
  return row as ConnectorConfig | null;
}

async function claimConnector(
  runStartedAtIso: string,
): Promise<DispatchClaimRow | null> {
  const response = await postgrestRequest(
    "POST",
    "rpc/uk_aq_rpc_dispatch_claim",
    {
      schema: "uk_aq_public",
      body: {
        p_connector_code: CONNECTOR_CODE,
        p_run_started_at: runStartedAtIso,
        p_timeout_minutes: CLAIM_TIMEOUT_MINUTES,
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `Dispatch claim failed (${response.status}): ${response.text}`,
    );
  }
  const rows = Array.isArray(response.data) ? response.data : [];
  const row = toObject(rows[0]);
  return row as DispatchClaimRow | null;
}

async function updateConnectorRun(
  connectorId: number,
  runStartedAtIso: string,
  runEndedAtIso: string,
  runStatus: string,
  runMessage: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    last_run_start: runStartedAtIso,
    last_run_end: runEndedAtIso,
    last_run_status: runStatus,
    last_run_message: runMessage,
  };
  if (runStatus === "succeeded" || runStatus === "success") {
    body.last_polled_at = runStartedAtIso;
  }
  const response = await postgrestRequest("PATCH", "connectors", {
    query: { id: `eq.${connectorId}` },
    body,
    prefer: "return=minimal",
  });
  if (!response.ok) {
    throw new Error(
      `Failed to update connector run (${response.status}): ${response.text}`,
    );
  }
}

async function insertRunRow(
  connectorId: number,
  runStartedAtIso: string,
  runEndedAtIso: string,
  runStatus: string,
  runMessage: string,
  ingestResponse: IngestResponse,
  payload: Record<string, unknown> | null,
): Promise<void> {
  const row = {
    connector_id: connectorId,
    connector_code: CONNECTOR_CODE,
    run_started_at: runStartedAtIso,
    run_ended_at: runEndedAtIso,
    run_status: runStatus,
    run_message: runMessage,
    last_observed_at: toStringOrNull(payload?.last_observed_at) ||
      toStringOrNull(payload?.last_observed),
    stations_updated: toIntegerOrNull(payload?.stations_updated) ??
      toIntegerOrNull(payload?.stations) ??
      toIntegerOrNull(payload?.stations_processed),
    observations_upserted: toIntegerOrNull(payload?.observations_upserted) ??
      toIntegerOrNull(payload?.observations),
    timeseries_updated: toIntegerOrNull(payload?.timeseries_updated) ??
      toIntegerOrNull(payload?.timeseries),
    series_polled: toIntegerOrNull(payload?.series_polled) ??
      toIntegerOrNull(payload?.timeseries) ??
      toIntegerOrNull(payload?.timeseries_updated),
    response_payload: compactRunResponsePayload(payload),
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

async function insertErrorLog(
  connectorId: number,
  ingestResponse: IngestResponse,
): Promise<void> {
  const entry = {
    id: crypto.randomUUID(),
    source: "cloud_run",
    severity: "error",
    message: "ingest_breathelondon dispatch failed",
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

async function waitForServer(url: string, maxWaitMs = 30_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      // BL handler returns 405 for GET, which is enough to confirm ready.
      if (response.status > 0) {
        return;
      }
    } catch {
      // wait and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for local BL server startup.");
}

function logSummary(message: string, details: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      connector_code: CONNECTOR_CODE,
      message,
      ...details,
    }),
  );
}

async function runIngestOnce(
  payload: Record<string, unknown>,
): Promise<IngestResponse> {
  const headers: HeadersInit = {
    "content-type": "application/json",
  };
  if (CRON_SECRET) {
    headers["x-cron-secret"] = CRON_SECRET;
  }
  const response = await fetch(`http://127.0.0.1:${PORT}/`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  let body: unknown = raw;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    body,
    raw,
  };
}

async function main(): Promise<void> {
  const now = new Date();
  const runStartedAtIso = now.toISOString();
  const connector = await loadConnector();
  const due = evaluateDue(connector, now);
  if (!due.due) {
    logSummary("skipped", {
      reason: due.reason,
      interval_minutes: due.intervalMinutes,
      poll_enabled: connector?.poll_enabled,
      scheduler_backend: toStringOrNull(connector?.scheduler_backend) ||
        SCHEDULER_BACKEND_SUPABASE_FUNCTION,
    });
    return;
  }

  const claim = await claimConnector(runStartedAtIso);
  if (!claim || claim.claimed !== true) {
    logSummary("skipped", {
      reason: "claim_not_acquired",
      claim,
    });
    return;
  }

  const claimedConnectorId = toIntegerOrNull(claim.connector_id);
  let connectorId: number | null = claimedConnectorId ??
    toIntegerOrNull(connector?.id);
  const payloadPlan = await buildIngestPayload(connector);

  if (!payloadPlan.stationRefs.length) {
    const runEndedAtIso = new Date().toISOString();
    const runStatus = "skipped";
    const runMessage = "no_station_refs";
    const ingestResponse: IngestResponse = {
      ok: true,
      status: 204,
      body: {
        run_status: runStatus,
        run_message: runMessage,
        connector_code: CONNECTOR_CODE,
      },
      raw: "",
    };
    if (connectorId === null) {
      connectorId = await resolveConnectorId(null);
    }
    await updateConnectorRun(
      connectorId,
      runStartedAtIso,
      runEndedAtIso,
      runStatus,
      runMessage,
    );
    await insertRunRow(
      connectorId,
      runStartedAtIso,
      runEndedAtIso,
      runStatus,
      runMessage,
      ingestResponse,
      toObject(ingestResponse.body),
    );
    logSummary("skipped", {
      reason: runMessage,
      connector_id: connectorId,
      batch_limit: payloadPlan.batchLimit,
      window_hours: payloadPlan.windowHours,
    });
    return;
  }

  logSummary("dispatching", {
    connector_id: connectorId,
    batch_limit: payloadPlan.batchLimit,
    window_hours: payloadPlan.windowHours,
    station_refs_count: payloadPlan.stationRefs.length,
  });

  const server = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "/app/runtime/ingest_breathelondon/index.ts",
    ],
    env: {
      ...Deno.env.toObject(),
      BREATHELONDON_DROPBOX_UPLOAD_SOURCE: "cloud_run",
    },
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  let ingestResponse: IngestResponse | null = null;

  try {
    await waitForServer(`http://127.0.0.1:${PORT}/`);
    ingestResponse = await runIngestOnce(payloadPlan.payload);

    const { runStatus, runMessage, payload } = deriveRunSummary(ingestResponse);
    const runEndedAtIso = new Date().toISOString();
    if (connectorId === null) {
      connectorId = await resolveConnectorId(payload);
    }

    await updateConnectorRun(
      connectorId,
      runStartedAtIso,
      runEndedAtIso,
      runStatus,
      runMessage,
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

    if (!ingestResponse.ok || runStatus === "failed" || runStatus === "error") {
      await insertErrorLog(connectorId, ingestResponse);
      throw new Error(
        `ingest_breathelondon failed (${ingestResponse.status}): ${ingestResponse.raw}`,
      );
    }

    logSummary("success", {
      run_status: runStatus,
      response_status: ingestResponse.status,
      connector_id: connectorId,
      observations_upserted: toIntegerOrNull(payload?.observations_upserted),
      observations_rows_input: toIntegerOrNull(payload?.observations_rows_input),
      observations_rows_prepared: toIntegerOrNull(
        payload?.observations_rows_prepared,
      ),
      observations_rows_deduped_prewrite: toIntegerOrNull(
        payload?.observations_rows_deduped_prewrite,
      ),
      history_rows_prepared: toIntegerOrNull(payload?.history_rows_prepared),
      history_rows_deduped_prewrite: toIntegerOrNull(
        payload?.history_rows_deduped_prewrite,
      ),
      series_polled: toIntegerOrNull(payload?.series_polled),
      stations_processed: toIntegerOrNull(payload?.stations_processed),
    });
  } finally {
    try {
      server.kill("SIGTERM");
    } catch {
      // Process may already be closed.
    }
    try {
      await Promise.race([
        server.status,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      // Ignore shutdown race.
    }
  }

  if (!ingestResponse) {
    throw new Error("No BL ingest response received.");
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logSummary("failure", { error: message });
  Deno.exit(1);
});
