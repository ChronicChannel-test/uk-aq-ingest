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
const EDGE_TIMEOUT_MS = parsePositiveInt(
  process.env.SCOMM_EDGE_TIMEOUT_MS,
  380_000,
);
const HTTP_TIMEOUT_MS = parsePositiveInt(
  process.env.SCOMM_HTTP_TIMEOUT_MS,
  60_000,
);
const SCOMM_COUNTRY = process.env.SCOMM_COUNTRY || "GB";

const SUPABASE_URL = requiredEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const SB_ANON_JWT =
  process.env.SB_ANON_JWT || process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY;
const SB_UK_AQ_CRON_SECRET = process.env.SB_UK_AQ_CRON_SECRET || "";
const UK_AQ_CORE_SCHEMA = process.env.UK_AQ_CORE_SCHEMA || "uk_aq_core";
const UK_AQ_RAW_SCHEMA = process.env.UK_AQ_RAW_SCHEMA || "uk_aq_raw";
const REST_BASE_URL = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1`;

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

function postgrestHeaders(schema, write = false) {
  const headers = {
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

function withQuery(path, query) {
  const url = new URL(`${REST_BASE_URL}/${path}`);
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
  const url = withQuery(path, options.query);
  const write = method !== "GET";
  const headers = postgrestHeaders(schema, write);
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
        "id,connector_code,poll_enabled,poll_interval_minutes,scheduler_backend,last_polled_at,last_run_start,last_run_end,last_run_status",
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

async function invokeSensorCommunity() {
  const url = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/ingest_sensorcommunity`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${SB_ANON_JWT}`,
    apikey: SB_ANON_JWT,
  };
  if (SB_UK_AQ_CRON_SECRET) {
    headers["X-Cron-Secret"] = SB_UK_AQ_CRON_SECRET;
  }

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        source: "google_cloud_run",
        connector_code: CONNECTOR_CODE,
        country: SCOMM_COUNTRY,
      }),
    },
    EDGE_TIMEOUT_MS,
  );

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    body,
    raw: text,
  };
}

function deriveRunSummary(ingestResponse) {
  const payload = toObject(ingestResponse.body);
  const rawRunStatus = toStringOrNull(payload?.run_status) ||
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

async function updateConnectorRun(connectorId, runEndedAtIso, runStatus, runMessage, runStartedAtIso) {
  const payload = {
    last_run_end: runEndedAtIso,
    last_run_status: runStatus,
    last_run_message: runMessage,
  };
  if (runStatus === "success") {
    payload.last_polled_at = runStartedAtIso;
  }
  const response = await postgrestRequest("PATCH", "connectors", {
    query: { id: `eq.${connectorId}` },
    body: payload,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to update connector run (${response.status}): ${response.text}`,
    );
  }
}

async function insertRunRow(connectorId, runStartedAtIso, runEndedAtIso, runStatus, runMessage, ingestResponse, payload) {
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
  try {
    ingestResponse = await invokeSensorCommunity();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ingestResponse = {
      ok: false,
      status: 504,
      body: {
        error: "dispatch_edge_timeout",
        message,
      },
      raw: message,
    };
  }
  const runEndedAtIso = new Date().toISOString();
  const { runStatus, runMessage, payload } = deriveRunSummary(ingestResponse);
  const runFailed = !ingestResponse.ok || runStatus === "failed" || runStatus === "error";

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

  if (runFailed) {
    await insertErrorLog(connectorId, ingestResponse);
    throw new Error(
      `ingest_sensorcommunity failed (${ingestResponse.status}): ${ingestResponse.raw || runMessage}`,
    );
  }

  logSummary("success", {
    run_status: runStatus,
    response_status: ingestResponse.status,
    interval_minutes: dueCheck.intervalMinutes,
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logSummary("failure", { error: message });
  process.exitCode = 1;
});
