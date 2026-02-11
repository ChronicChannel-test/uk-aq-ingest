const CONNECTOR_CODE =
  (Deno.env.get("BREATHELONDON_CONNECTOR_CODE") || "breathelondon").trim();
const PORT = parsePositiveInt(
  Deno.env.get("BREATHELONDON_LOCAL_PORT") || Deno.env.get("PORT"),
  8000,
);
const REQUEST_PAYLOAD_RAW = (Deno.env.get("BREATHELONDON_REQUEST_PAYLOAD") ||
  "{}").trim();
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

function postgrestHeaders(schema: string, write = false): Record<string, string> {
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
      runMessage = `ingest_breathelondon failed with status ${ingestResponse.status}`;
    }
  }

  return { runStatus, runMessage, payload };
}

async function resolveConnectorId(payload: Record<string, unknown> | null): Promise<number> {
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
    stations_updated: toIntegerOrNull(payload?.stations_updated) ||
      toIntegerOrNull(payload?.stations) ||
      toIntegerOrNull(payload?.stations_processed),
    observations_upserted: toIntegerOrNull(payload?.observations_upserted) ||
      toIntegerOrNull(payload?.observations),
    timeseries_updated: toIntegerOrNull(payload?.timeseries_updated) ||
      toIntegerOrNull(payload?.timeseries),
    series_polled: toIntegerOrNull(payload?.series_polled) ||
      toIntegerOrNull(payload?.timeseries) ||
      toIntegerOrNull(payload?.timeseries_updated),
    response_status: ingestResponse.status,
  };

  const response = await postgrestRequest("POST", "uk_aq_ingest_runs", {
    body: row,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to insert uk_aq_ingest_runs row (${response.status}): ${response.text}`,
    );
  }
}

async function insertErrorLog(connectorId: number, ingestResponse: IngestResponse): Promise<void> {
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

async function runIngestOnce(): Promise<IngestResponse> {
  const headers: HeadersInit = {
    "content-type": "application/json",
  };
  if (CRON_SECRET) {
    headers["x-cron-secret"] = CRON_SECRET;
  }
  const response = await fetch(`http://127.0.0.1:${PORT}/`, {
    method: "POST",
    headers,
    body: REQUEST_PAYLOAD_RAW,
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
  const server = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "/app/runtime/ingest_breathelondon/index.ts",
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  const runStartedAtIso = new Date().toISOString();
  let ingestResponse: IngestResponse | null = null;
  let connectorId: number | null = null;

  try {
    await waitForServer(`http://127.0.0.1:${PORT}/`);
    ingestResponse = await runIngestOnce();

    const { runStatus, runMessage, payload } = deriveRunSummary(ingestResponse);
    const runEndedAtIso = new Date().toISOString();
    connectorId = await resolveConnectorId(payload);

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
