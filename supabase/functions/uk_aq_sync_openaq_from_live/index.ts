import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import "../_shared/fetch_egress_patch.ts";
import {
  type ObservsObservationRow,
  observsUpsertObservations,
} from "../_shared/observs_client.ts";

type Mode = "observations" | "core" | "reseed";

type LockAcquireRow = {
  acquired: boolean;
  job_name: string;
  cursor_observed_at: string | null;
  cursor_timeseries_id: number | null;
  cursor_core_synced_at: string | null;
  lock_owner: string | null;
  lock_expires_at: string | null;
  last_status: string | null;
  last_error: string | null;
};

type CountRow = {
  observations_upserted?: number;
  rows_updated?: number;
  rows_deleted?: number;
};

type SequenceReseedRow = {
  sequence_name: string;
  set_to: number;
};

type ConnectorRow = {
  id: number;
  connector_code: string;
  label: string;
  display_name: string | null;
  service_url: string | null;
  station_display_name_template: string | null;
  overwrite_station_name: boolean | null;
  poll_enabled: boolean | null;
  poll_interval_minutes: number | null;
  poll_window_hours: number | null;
  poll_timeseries_batch_size: number | null;
  scheduler_backend: string | null;
  stations_bbox_supported: boolean | null;
  timeseries_station_filter_supported: boolean | null;
  last_polled_at: string | null;
  last_run_start: string | null;
  last_run_end: string | null;
  last_run_status: string | null;
  last_run_message: string | null;
  created_at: string | null;
};

type PhenomenonRow = {
  id: number;
  label: string;
  source_label: string | null;
  notation: string | null;
  pollutant_label: string | null;
  observed_property_id: number | null;
  connector_id: number;
};

type StationRow = {
  id: number;
  station_ref: string;
  service_ref: string;
  label: string;
  station_name: string | null;
  station_type: string | null;
  station_exposure: string | null;
  region: string | null;
  la_code: string | null;
  la_version: string | null;
  pcon_code: string | null;
  pcon_version: string | null;
  geometry: unknown;
  connector_id: number;
  category_id: number | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  removed_at: string | null;
  created_at: string | null;
};

type TimeseriesRow = {
  id: number;
  timeseries_ref: string;
  label: string;
  uom: string | null;
  station_id: number | null;
  service_ref: string;
  connector_id: number;
  offering_id: number | null;
  feature_id: number | null;
  procedure_id: number | null;
  phenomenon_id: number | null;
  category_id: number | null;
  first_value_at: string | null;
  last_value_at: string | null;
  last_value: number | null;
  extras: unknown;
  rendering_hints: unknown;
  status_intervals: unknown;
  last_catalog_seen_at: string | null;
  catalog_missing_runs: number;
  ended_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type ObservationRow = {
  connector_id: number;
  timeseries_id: number;
  observed_at: string;
  value: number | null;
  status: string | null;
};

type PostgrestClient = {
  baseUrl: string;
  key: string;
  caller: string;
};

type SyncResult = {
  mode: Mode;
  started_at: string;
  finished_at: string;
  lock_owner: string;
  source_connector_id: number;
  target_connector_id: number;
  overlap_minutes: number;
  rows_read: number;
  rows_written_ingest: number;
  rows_written_observs: number;
  pages: number;
  detail: Record<string, unknown>;
};

const OPENAQ_CONNECTOR_CODE = "openaq";
const UK_AQ_CORE_SCHEMA = Deno.env.get("UK_AQ_CORE_SCHEMA") ?? "uk_aq_core";
const UK_AQ_PUBLIC_SCHEMA = Deno.env.get("UK_AQ_PUBLIC_SCHEMA") ??
  "uk_aq_public";

const TARGET_SUPABASE_URL = (
  Deno.env.get("SUPABASE_URL") ??
    Deno.env.get("SB_SUPABASE_URL") ??
    ""
).trim();
const TARGET_SB_SECRET_KEY = (
  Deno.env.get("SB_SECRET_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    ""
).trim();

const SOURCE_SUPABASE_URL = (
  Deno.env.get("OPENAQ_LIVE_SOURCE_SUPABASE_URL") ??
    ""
).trim();
const SOURCE_SB_SECRET_KEY = (
  Deno.env.get("OPENAQ_LIVE_SOURCE_SB_SECRET_KEY") ??
    ""
).trim();

const MIRROR_AUTH_TOKEN = (Deno.env.get("UK_AQ_OPENAQ_MIRROR_AUTH_TOKEN") ?? "")
  .trim();
const SB_UK_AQ_CRON_SECRET = (Deno.env.get("SB_UK_AQ_CRON_SECRET") ?? "")
  .trim();

const OBS_AQIDB_SUPABASE_URL = (Deno.env.get("OBS_AQIDB_SUPABASE_URL") ?? "")
  .trim();
const OBS_AQIDB_SECRET_KEY = (Deno.env.get("OBS_AQIDB_SECRET_KEY") ?? "")
  .trim();

const DEFAULT_PAGE_SIZE = parsePositiveInt(
  Deno.env.get("OPENAQ_MIRROR_PAGE_SIZE"),
  1000,
  100,
  5000,
);
const DEFAULT_OBSERVATION_OVERLAP_MINUTES = parsePositiveInt(
  Deno.env.get("OPENAQ_MIRROR_OBSERVATION_OVERLAP_MINUTES"),
  5,
  0,
  120,
);
const DEFAULT_CORE_OVERLAP_MINUTES = parsePositiveInt(
  Deno.env.get("OPENAQ_MIRROR_CORE_OVERLAP_MINUTES"),
  60,
  0,
  1440,
);
const DEFAULT_INITIAL_OBSERVATION_LOOKBACK_HOURS = parsePositiveInt(
  Deno.env.get("OPENAQ_MIRROR_INITIAL_OBSERVATION_LOOKBACK_HOURS"),
  72,
  1,
  720,
);
const DEFAULT_RESEED_LOOKBACK_HOURS = parsePositiveInt(
  Deno.env.get("OPENAQ_MIRROR_RESEED_LOOKBACK_HOURS"),
  168,
  1,
  2160,
);
const OBSERVATION_UPSERT_CHUNK_SIZE = parsePositiveInt(
  Deno.env.get("OPENAQ_MIRROR_OBSERVATION_UPSERT_CHUNK_SIZE"),
  5000,
  100,
  10000,
);
const OBSERVATION_MAX_PAGES_PER_RUN = 1;
const CORE_DELETE_BATCH_SIZE = 200;
const TIMESERIES_EXISTS_CHUNK_SIZE = 100;
const LOCK_LEASE_SECONDS = parsePositiveInt(
  Deno.env.get("OPENAQ_MIRROR_LOCK_LEASE_SECONDS"),
  1800,
  30,
  7200,
);

const PHENOMENA_SELECT =
  "id,label,source_label,notation,pollutant_label,observed_property_id,connector_id";
const STATIONS_SELECT =
  "id,station_ref,service_ref,label,station_name,station_type,station_exposure,region,la_code,la_version,pcon_code,pcon_version,geometry,connector_id,category_id,first_seen_at,last_seen_at,removed_at,created_at";
const TIMESERIES_SELECT =
  "id,timeseries_ref,label,uom,station_id,service_ref,connector_id,offering_id,feature_id,procedure_id,phenomenon_id,category_id,first_value_at,last_value_at,last_value,extras,rendering_hints,status_intervals,last_catalog_seen_at,catalog_missing_runs,ended_at,created_at,updated_at";

const HAS_OBS_AQIDB = Boolean(OBS_AQIDB_SUPABASE_URL && OBS_AQIDB_SECRET_KEY);

function parsePositiveInt(
  raw: string | undefined | null,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number(raw ?? "");
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const normalized = Math.trunc(parsed);
  if (normalized < min || normalized > max) {
    return fallback;
  }
  return normalized;
}

function asIso(value: Date): string {
  return value.toISOString();
}

function nowIso(): string {
  return asIso(new Date());
}

function addMinutes(iso: string, minutes: number): string {
  const d = new Date(iso);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return asIso(d);
}

function addHours(iso: string, hours: number): string {
  const d = new Date(iso);
  d.setUTCHours(d.getUTCHours() + hours);
  return asIso(d);
}

function subtractMinutes(iso: string, minutes: number): string {
  return addMinutes(iso, -minutes);
}

function subtractHours(iso: string, hours: number): string {
  return addHours(iso, -hours);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function shortError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function requireRuntimeConfig(): void {
  if (!TARGET_SUPABASE_URL || !TARGET_SB_SECRET_KEY) {
    throw new Error(
      "Missing target SUPABASE_URL/SB_SECRET_KEY for test ingest DB.",
    );
  }
  if (!SOURCE_SUPABASE_URL || !SOURCE_SB_SECRET_KEY) {
    throw new Error(
      "Missing OPENAQ_LIVE_SOURCE_SUPABASE_URL or OPENAQ_LIVE_SOURCE_SB_SECRET_KEY.",
    );
  }
}

function requireAuth(req: Request): Response | null {
  if (MIRROR_AUTH_TOKEN) {
    const authHeader = req.headers.get("authorization") ?? "";
    const expected = `Bearer ${MIRROR_AUTH_TOKEN}`;
    if (authHeader.trim() !== expected) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  if (SB_UK_AQ_CRON_SECRET) {
    const cronHeader = req.headers.get("x-cron-secret") ?? "";
    if (cronHeader.trim() !== SB_UK_AQ_CRON_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  return null;
}

function buildClient(
  baseUrl: string,
  key: string,
  caller: string,
): PostgrestClient {
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    key,
    caller,
  };
}

function postgrestHeaders(
  client: PostgrestClient,
  schema?: string,
  preferMinimal = false,
  preferHeader?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    apikey: client.key,
    Authorization: `Bearer ${client.key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-ukaq-egress-caller": client.caller,
  };
  if (schema && schema !== "public") {
    headers["Accept-Profile"] = schema;
    headers["Content-Profile"] = schema;
  }
  if (preferHeader) {
    headers.Prefer = preferHeader;
  } else if (preferMinimal) {
    headers.Prefer = "return=minimal";
  }
  return headers;
}

async function postgrestRequest<T>(
  client: PostgrestClient,
  method: string,
  path: string,
  options: {
    schema?: string;
    params?: Record<string, string | number | boolean | undefined | null>;
    body?: unknown;
    preferMinimal?: boolean;
    preferHeader?: string;
  } = {},
): Promise<T> {
  const url = new URL(`${client.baseUrl}/rest/v1/${path}`);
  for (const [key, rawValue] of Object.entries(options.params ?? {})) {
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    url.searchParams.set(key, String(rawValue));
  }

  const response = await fetch(url.toString(), {
    method,
    headers: postgrestHeaders(
      client,
      options.schema,
      options.preferMinimal,
      options.preferHeader,
    ),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (response.status === 204) {
    return [] as T;
  }

  const rawText = await response.text();
  const payload = rawText ? safeParseJson(rawText) : null;

  if (!response.ok) {
    const message = payload?.message ?? payload?.error ?? response.statusText;
    throw new Error(
      `PostgREST ${method} ${path} failed (${response.status}): ${message}`,
    );
  }

  return (payload ?? []) as T;
}

function safeParseJson(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return { message: value };
  }
}

async function callRpc<T>(
  client: PostgrestClient,
  rpcName: string,
  args: Record<string, unknown>,
  schema = UK_AQ_PUBLIC_SCHEMA,
): Promise<T> {
  return await postgrestRequest<T>(client, "POST", `rpc/${rpcName}`, {
    schema,
    body: args,
  });
}

async function fetchSingleConnectorByCode(
  client: PostgrestClient,
  connectorCode: string,
): Promise<ConnectorRow | null> {
  const rows = await postgrestRequest<ConnectorRow[]>(
    client,
    "GET",
    "connectors",
    {
      schema: UK_AQ_CORE_SCHEMA,
      params: {
        select:
          "id,connector_code,label,display_name,service_url,station_display_name_template,overwrite_station_name,poll_enabled,poll_interval_minutes,poll_window_hours,poll_timeseries_batch_size,scheduler_backend,stations_bbox_supported,timeseries_station_filter_supported,last_polled_at,last_run_start,last_run_end,last_run_status,last_run_message,created_at",
        connector_code: `eq.${connectorCode}`,
        limit: 1,
      },
    },
  );
  return rows[0] ?? null;
}

async function fetchConnectorIdsByCode(
  client: PostgrestClient,
  connectorCode: string,
): Promise<number[]> {
  const rows = await postgrestRequest<Array<{ id: number }>>(
    client,
    "GET",
    "connectors",
    {
      schema: UK_AQ_CORE_SCHEMA,
      params: {
        select: "id",
        connector_code: `eq.${connectorCode}`,
      },
    },
  );

  return rows
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

async function syncCoreTableByConnector(
  sourceClient: PostgrestClient,
  targetClient: PostgrestClient,
  table: "phenomena" | "stations" | "timeseries",
  connectorId: number,
  select: string,
  options: {
    deltaOrFilter?: string | null;
    order?: string;
  } = {},
): Promise<{ rowsRead: number; rowsWritten: number }> {
  let offset = 0;
  let rowsRead = 0;
  let rowsWritten = 0;

  while (true) {
    const params: Record<string, string | number> = {
      select,
      connector_id: `eq.${connectorId}`,
      order: options.order ?? "id.asc",
      limit: DEFAULT_PAGE_SIZE,
      offset,
    };
    if (options.deltaOrFilter) {
      params.or = options.deltaOrFilter;
    }

    const batch = await postgrestRequest<Array<Record<string, unknown>>>(
      sourceClient,
      "GET",
      table,
      {
        schema: UK_AQ_CORE_SCHEMA,
        params,
      },
    );

    if (!batch.length) {
      break;
    }

    rowsRead += batch.length;
    rowsWritten += await upsertCoreRows(targetClient, table, batch);

    if (batch.length < DEFAULT_PAGE_SIZE) {
      break;
    }
    offset += batch.length;
  }

  return { rowsRead, rowsWritten };
}

async function fetchExistingTimeseriesIds(
  client: PostgrestClient,
  timeseriesIds: number[],
): Promise<Set<number>> {
  const uniqueIds = Array.from(
    new Set(
      timeseriesIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  );
  const existing = new Set<number>();
  if (!uniqueIds.length) {
    return existing;
  }

  for (let i = 0; i < uniqueIds.length; i += TIMESERIES_EXISTS_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + TIMESERIES_EXISTS_CHUNK_SIZE);
    const rows = await postgrestRequest<Array<{ id: number }>>(
      client,
      "GET",
      "timeseries",
      {
        schema: UK_AQ_CORE_SCHEMA,
        params: {
          select: "id",
          id: `in.(${chunk.join(",")})`,
        },
      },
    );
    for (const row of rows) {
      const id = Number(row.id);
      if (Number.isInteger(id) && id > 0) {
        existing.add(id);
      }
    }
  }

  return existing;
}

async function upsertCoreRows(
  targetClient: PostgrestClient,
  table: "connectors" | "phenomena" | "stations" | "timeseries",
  rows: Array<Record<string, unknown>>,
): Promise<number> {
  if (!rows.length) {
    return 0;
  }

  let payloadRows = rows;

  if (table === "stations") {
    payloadRows = rows.map((row) => ({
      ...row,
      category_id: row.category_id ?? null,
    }));
  }
  if (table === "timeseries") {
    payloadRows = rows.map((row) => ({
      ...row,
      offering_id: row.offering_id ?? null,
      feature_id: row.feature_id ?? null,
      procedure_id: row.procedure_id ?? null,
      category_id: row.category_id ?? null,
    }));
  }

  const doUpsert = async (
    inputRows: Array<Record<string, unknown>>,
  ): Promise<void> => {
    for (let i = 0; i < inputRows.length; i += DEFAULT_PAGE_SIZE) {
      const chunk = inputRows.slice(i, i + DEFAULT_PAGE_SIZE);
      await postgrestRequest<unknown>(
        targetClient,
        "POST",
        `${table}?on_conflict=id`,
        {
          schema: UK_AQ_CORE_SCHEMA,
          body: chunk,
          preferHeader: "resolution=merge-duplicates,return=minimal",
        },
      );
    }
  };

  try {
    await doUpsert(payloadRows);
    return payloadRows.length;
  } catch (error) {
    if (table === "phenomena") {
      const sanitized = payloadRows.map((row) => ({
        ...row,
        observed_property_id: null,
      }));
      await doUpsert(sanitized);
      return sanitized.length;
    }
    if (table === "stations") {
      const sanitized = payloadRows.map((row) => ({
        ...row,
        category_id: null,
      }));
      await doUpsert(sanitized);
      return sanitized.length;
    }
    if (table === "timeseries") {
      const sanitized = payloadRows.map((row) => ({
        ...row,
        offering_id: null,
        feature_id: null,
        procedure_id: null,
        category_id: null,
      }));
      await doUpsert(sanitized);
      return sanitized.length;
    }
    throw error;
  }
}

async function deleteRowsByConnectorId(
  targetClient: PostgrestClient,
  table: string,
  connectorIds: number[],
): Promise<void> {
  if (!connectorIds.length) {
    return;
  }
  const list = connectorIds.join(",");

  while (true) {
    const idRows = await postgrestRequest<Array<{ id: number }>>(
      targetClient,
      "GET",
      table,
      {
        schema: UK_AQ_CORE_SCHEMA,
        params: {
          select: "id",
          connector_id: `in.(${list})`,
          order: "id.asc",
          limit: CORE_DELETE_BATCH_SIZE,
        },
      },
    );

    if (!idRows.length) {
      break;
    }

    const ids = idRows.map((row) => row.id).join(",");
    await postgrestRequest<unknown>(targetClient, "DELETE", table, {
      schema: UK_AQ_CORE_SCHEMA,
      params: {
        id: `in.(${ids})`,
      },
      preferMinimal: true,
    });

    if (idRows.length < CORE_DELETE_BATCH_SIZE) {
      break;
    }
  }
}

async function deleteObservationsByConnectorId(
  targetClient: PostgrestClient,
  connectorIds: number[],
): Promise<void> {
  if (!connectorIds.length) {
    return;
  }
  const list = connectorIds.join(",");
  await postgrestRequest<unknown>(targetClient, "DELETE", "observations", {
    schema: UK_AQ_CORE_SCHEMA,
    params: {
      connector_id: `in.(${list})`,
    },
    preferMinimal: true,
  });
}

async function deleteObservsRowsByConnectorId(
  connectorIds: number[],
): Promise<void> {
  if (!HAS_OBS_AQIDB || !connectorIds.length) {
    return;
  }
  const obsClient = buildClient(
    OBS_AQIDB_SUPABASE_URL,
    OBS_AQIDB_SECRET_KEY,
    "uk_aq_sync_openaq_from_live",
  );
  const list = connectorIds.join(",");
  try {
    await postgrestRequest<unknown>(obsClient, "DELETE", "observations", {
      schema: "uk_aq_observs",
      params: {
        connector_id: `in.(${list})`,
      },
      preferMinimal: true,
    });
  } catch (error) {
    const message = shortError(error).toLowerCase();
    if (message.includes("invalid schema")) {
      console.warn(
        "obs_aqidb_observations_delete_skipped",
        {
          reason: "schema_not_exposed_via_postgrest",
          connector_ids: connectorIds,
        },
      );
      return;
    }
    throw error;
  }
}

async function upsertMainObservations(
  targetClient: PostgrestClient,
  rows: ObservationRow[],
): Promise<number> {
  if (!rows.length) {
    return 0;
  }

  let written = 0;
  for (let i = 0; i < rows.length; i += OBSERVATION_UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + OBSERVATION_UPSERT_CHUNK_SIZE);
    const result = await callRpc<CountRow[]>(
      targetClient,
      "uk_aq_rpc_observations_upsert",
      { rows: chunk },
      UK_AQ_PUBLIC_SCHEMA,
    );
    written += Number(result?.[0]?.observations_upserted ?? 0);
  }
  return written;
}

async function upsertObservsObservations(
  rows: ObservationRow[],
): Promise<number> {
  if (!HAS_OBS_AQIDB || !rows.length) {
    return 0;
  }
  const normalized: ObservsObservationRow[] = rows.map((row) => ({
    connector_id: row.connector_id,
    timeseries_id: row.timeseries_id,
    observed_at: row.observed_at,
    value: row.value,
    status: row.status,
  }));
  return await observsUpsertObservations(normalized);
}

function parseMode(value: unknown): Mode {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "core") {
    return "core";
  }
  if (normalized === "reseed") {
    return "reseed";
  }
  return "observations";
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseOptionalInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === null || value === undefined || String(value).trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const normalized = Math.trunc(parsed);
  if (normalized < min || normalized > max) {
    return fallback;
  }
  return normalized;
}

async function acquireLock(
  targetClient: PostgrestClient,
  mode: Mode,
): Promise<LockAcquireRow> {
  const lockOwner = crypto.randomUUID();
  const rows = await callRpc<LockAcquireRow[]>(
    targetClient,
    "uk_aq_rpc_openaq_live_sync_lock_acquire",
    {
      p_job_name: mode,
      p_lock_owner: lockOwner,
      p_lease_seconds: LOCK_LEASE_SECONDS,
    },
    UK_AQ_PUBLIC_SCHEMA,
  );

  const row = rows?.[0];
  if (!row) {
    throw new Error(`Failed to acquire ${mode} lock: empty RPC response.`);
  }

  if (!row.lock_owner) {
    row.lock_owner = lockOwner;
  }

  return row;
}

async function releaseLock(
  targetClient: PostgrestClient,
  mode: Mode,
  lockOwner: string,
  payload: {
    status: "success" | "failed" | "skipped";
    error?: string | null;
    cursorObservedAt?: string | null;
    cursorTimeseriesId?: number | null;
    cursorCoreSyncedAt?: string | null;
    rowsRead?: number;
    rowsWrittenIngest?: number;
    rowsWrittenObservs?: number;
  },
): Promise<void> {
  await callRpc<CountRow[]>(
    targetClient,
    "uk_aq_rpc_openaq_live_sync_lock_release",
    {
      p_job_name: mode,
      p_lock_owner: lockOwner,
      p_status: payload.status,
      p_error: payload.error ?? null,
      p_cursor_observed_at: payload.cursorObservedAt ?? null,
      p_cursor_timeseries_id: payload.cursorTimeseriesId ?? null,
      p_cursor_core_synced_at: payload.cursorCoreSyncedAt ?? null,
      p_rows_read: payload.rowsRead ?? null,
      p_rows_written_ingest: payload.rowsWrittenIngest ?? null,
      p_rows_written_observs: payload.rowsWrittenObservs ?? null,
    },
    UK_AQ_PUBLIC_SCHEMA,
  );
}

async function runObservationsSync(
  sourceClient: PostgrestClient,
  targetClient: PostgrestClient,
  lockRow: LockAcquireRow,
  options: {
    overlapMinutes: number;
    initialLookbackHours: number;
    forceSinceIso?: string | null;
  },
): Promise<SyncResult> {
  const startedAt = nowIso();
  const sourceConnector = await fetchSingleConnectorByCode(
    sourceClient,
    OPENAQ_CONNECTOR_CODE,
  );
  if (!sourceConnector) {
    throw new Error("Live source OpenAQ connector not found.");
  }

  const targetConnector = await fetchSingleConnectorByCode(
    targetClient,
    OPENAQ_CONNECTOR_CODE,
  );
  if (!targetConnector) {
    throw new Error("Test target OpenAQ connector not found.");
  }

  if (sourceConnector.id !== targetConnector.id) {
    throw new Error(
      `OpenAQ connector ID mismatch (source=${sourceConnector.id}, target=${targetConnector.id}). Run reseed mode first.`,
    );
  }

  let cursorObservedAt = options.forceSinceIso
    ? null
    : lockRow.cursor_observed_at;
  let cursorTimeseriesId = options.forceSinceIso
    ? null
    : lockRow.cursor_timeseries_id;

  const baselineSince = options.forceSinceIso ??
    (cursorObservedAt
      ? subtractMinutes(cursorObservedAt, options.overlapMinutes)
      : subtractHours(startedAt, options.initialLookbackHours));

  const rowsRead = { value: 0 };
  const rowsWrittenIngest = { value: 0 };
  const rowsWrittenObservs = { value: 0 };
  const rowsSkippedMissingTimeseries = { value: 0 };
  let pages = 0;

  while (true) {
    const params: Record<string, string | number> = {
      select: "connector_id,timeseries_id,observed_at,value,status",
      connector_id: `eq.${sourceConnector.id}`,
      observed_at: `gte.${baselineSince}`,
      order: "observed_at.asc,timeseries_id.asc",
      limit: DEFAULT_PAGE_SIZE,
    };

    if (
      cursorObservedAt && cursorTimeseriesId !== null &&
      cursorTimeseriesId !== undefined
    ) {
      params.or =
        `(observed_at.gt.${cursorObservedAt},and(observed_at.eq.${cursorObservedAt},timeseries_id.gt.${cursorTimeseriesId}))`;
    }

    const batch = await postgrestRequest<ObservationRow[]>(
      sourceClient,
      "GET",
      "observations",
      {
        schema: UK_AQ_CORE_SCHEMA,
        params,
      },
    );

    if (!batch.length) {
      break;
    }

    rowsRead.value += batch.length;
    pages += 1;

    const existingTargetTimeseriesIds = await fetchExistingTimeseriesIds(
      targetClient,
      batch.map((row) => row.timeseries_id),
    );
    const ingestReadyRows = batch.filter((row) =>
      existingTargetTimeseriesIds.has(row.timeseries_id)
    );
    rowsSkippedMissingTimeseries.value += batch.length - ingestReadyRows.length;

    if (ingestReadyRows.length) {
      rowsWrittenIngest.value += await upsertMainObservations(
        targetClient,
        ingestReadyRows,
      );
    }

    if (HAS_OBS_AQIDB) {
      try {
        if (ingestReadyRows.length) {
          rowsWrittenObservs.value += await upsertObservsObservations(
            ingestReadyRows,
          );
        }
      } catch (error) {
        const message = shortError(error).toLowerCase();
        if (!message.includes("timeseries_id_fkey")) {
          throw error;
        }
        console.warn(
          "obs_aqidb_timeseries_fk_missing",
          { skipped_rows: ingestReadyRows.length },
        );
      }
    }

    const last = batch[batch.length - 1];
    cursorObservedAt = last.observed_at;
    cursorTimeseriesId = last.timeseries_id;

    if (pages >= OBSERVATION_MAX_PAGES_PER_RUN) {
      break;
    }
    if (batch.length < DEFAULT_PAGE_SIZE) {
      break;
    }
  }

  const finishedAt = nowIso();
  return {
    mode: "observations",
    started_at: startedAt,
    finished_at: finishedAt,
    lock_owner: lockRow.lock_owner ?? "",
    source_connector_id: sourceConnector.id,
    target_connector_id: targetConnector.id,
    overlap_minutes: options.overlapMinutes,
    rows_read: rowsRead.value,
    rows_written_ingest: rowsWrittenIngest.value,
    rows_written_observs: rowsWrittenObservs.value,
    pages,
    detail: {
      since: baselineSince,
      cursor_observed_at: cursorObservedAt,
      cursor_timeseries_id: cursorTimeseriesId,
      initial_lookback_hours: options.initialLookbackHours,
      force_since: options.forceSinceIso ?? null,
      skipped_rows_missing_timeseries: rowsSkippedMissingTimeseries.value,
    },
  };
}

async function runCoreSync(
  sourceClient: PostgrestClient,
  targetClient: PostgrestClient,
  lockRow: LockAcquireRow,
  options: {
    overlapMinutes: number;
    full: boolean;
    allowMissingTargetConnector?: boolean;
  },
): Promise<SyncResult> {
  const startedAt = nowIso();

  const sourceConnector = await fetchSingleConnectorByCode(
    sourceClient,
    OPENAQ_CONNECTOR_CODE,
  );
  if (!sourceConnector) {
    throw new Error("Live source OpenAQ connector not found.");
  }

  const targetConnector = await fetchSingleConnectorByCode(
    targetClient,
    OPENAQ_CONNECTOR_CODE,
  );
  if (!targetConnector && !options.allowMissingTargetConnector) {
    throw new Error("Test target OpenAQ connector not found.");
  }
  if (
    targetConnector &&
    targetConnector.id !== sourceConnector.id &&
    !options.allowMissingTargetConnector
  ) {
    throw new Error(
      `OpenAQ connector ID mismatch (source=${sourceConnector.id}, target=${targetConnector.id}). Run reseed mode first.`,
    );
  }
  const targetConnectorId = targetConnector?.id ?? sourceConnector.id;

  const coreCursor = lockRow.cursor_core_synced_at;
  const since = options.full || !coreCursor
    ? null
    : subtractMinutes(coreCursor, options.overlapMinutes);

  const rowsWrittenConnector = await upsertCoreRows(
    targetClient,
    "connectors",
    [sourceConnector as unknown as Record<string, unknown>],
  );

  const phenomenaSync = await syncCoreTableByConnector(
    sourceClient,
    targetClient,
    "phenomena",
    sourceConnector.id,
    PHENOMENA_SELECT,
  );
  const stationsSync = await syncCoreTableByConnector(
    sourceClient,
    targetClient,
    "stations",
    sourceConnector.id,
    STATIONS_SELECT,
    {
      deltaOrFilter: since
        ? `(created_at.gte.${since},first_seen_at.gte.${since},last_seen_at.gte.${since},removed_at.gte.${since})`
        : null,
    },
  );
  const timeseriesSync = await syncCoreTableByConnector(
    sourceClient,
    targetClient,
    "timeseries",
    sourceConnector.id,
    TIMESERIES_SELECT,
    {
      deltaOrFilter: since
        ? `(updated_at.gte.${since},created_at.gte.${since},last_value_at.gte.${since},last_catalog_seen_at.gte.${since},ended_at.gte.${since})`
        : null,
    },
  );

  const rowsRead = 1 + phenomenaSync.rowsRead + stationsSync.rowsRead +
    timeseriesSync.rowsRead;
  const rowsWrittenIngest = rowsWrittenConnector + phenomenaSync.rowsWritten +
    stationsSync.rowsWritten + timeseriesSync.rowsWritten;

  return {
    mode: "core",
    started_at: startedAt,
    finished_at: nowIso(),
    lock_owner: lockRow.lock_owner ?? "",
    source_connector_id: sourceConnector.id,
    target_connector_id: targetConnectorId,
    overlap_minutes: options.overlapMinutes,
    rows_read: rowsRead,
    rows_written_ingest: rowsWrittenIngest,
    rows_written_observs: 0,
    pages: 1,
    detail: {
      full: options.full,
      since,
      phenomena_rows: phenomenaSync.rowsRead,
      stations_rows: stationsSync.rowsRead,
      timeseries_rows: timeseriesSync.rowsRead,
    },
  };
}

async function runReseed(
  sourceClient: PostgrestClient,
  targetClient: PostgrestClient,
  lockRow: LockAcquireRow,
  options: {
    reseedLookbackHours: number;
    skipDelete: boolean;
  },
): Promise<SyncResult> {
  const startedAt = nowIso();

  const sourceConnector = await fetchSingleConnectorByCode(
    sourceClient,
    OPENAQ_CONNECTOR_CODE,
  );
  if (!sourceConnector) {
    throw new Error("Live source OpenAQ connector not found.");
  }

  const targetConnectorIds = await fetchConnectorIdsByCode(
    targetClient,
    OPENAQ_CONNECTOR_CODE,
  );

  if (!options.skipDelete) {
    try {
      await deleteObservationsByConnectorId(targetClient, targetConnectorIds);
      await deleteObservsRowsByConnectorId(targetConnectorIds);
      await deleteRowsByConnectorId(
        targetClient,
        "timeseries",
        targetConnectorIds,
      );
      await deleteRowsByConnectorId(
        targetClient,
        "stations",
        targetConnectorIds,
      );
      await deleteRowsByConnectorId(
        targetClient,
        "procedures",
        targetConnectorIds,
      );
      await deleteRowsByConnectorId(
        targetClient,
        "features",
        targetConnectorIds,
      );
      await deleteRowsByConnectorId(
        targetClient,
        "offerings",
        targetConnectorIds,
      );
      await deleteRowsByConnectorId(
        targetClient,
        "categories",
        targetConnectorIds,
      );
      await deleteRowsByConnectorId(
        targetClient,
        "phenomena",
        targetConnectorIds,
      );

      await postgrestRequest<unknown>(targetClient, "DELETE", "connectors", {
        schema: UK_AQ_CORE_SCHEMA,
        params: {
          connector_code: `eq.${OPENAQ_CONNECTOR_CODE}`,
        },
        preferMinimal: true,
      });
    } catch (error) {
      const message = shortError(error).toLowerCase();
      if (message.includes("statement timeout")) {
        throw new Error(
          "Reseed delete phase hit statement timeout. Run manual OpenAQ reset SQL first, then rerun reseed with skip_delete=true.",
        );
      }
      throw error;
    }
  }

  const coreResult = await runCoreSync(sourceClient, targetClient, lockRow, {
    overlapMinutes: DEFAULT_CORE_OVERLAP_MINUTES,
    full: true,
    allowMissingTargetConnector: true,
  });

  const observationsResult = await runObservationsSync(
    sourceClient,
    targetClient,
    lockRow,
    {
      overlapMinutes: DEFAULT_OBSERVATION_OVERLAP_MINUTES,
      initialLookbackHours: options.reseedLookbackHours,
      forceSinceIso: subtractHours(startedAt, options.reseedLookbackHours),
    },
  );

  const sequenceRows = await callRpc<SequenceReseedRow[]>(
    targetClient,
    "uk_aq_rpc_openaq_live_sync_sequence_reseed",
    {},
    UK_AQ_PUBLIC_SCHEMA,
  );

  return {
    mode: "reseed",
    started_at: startedAt,
    finished_at: nowIso(),
    lock_owner: lockRow.lock_owner ?? "",
    source_connector_id: sourceConnector.id,
    target_connector_id: sourceConnector.id,
    overlap_minutes: DEFAULT_OBSERVATION_OVERLAP_MINUTES,
    rows_read: coreResult.rows_read + observationsResult.rows_read,
    rows_written_ingest: coreResult.rows_written_ingest +
      observationsResult.rows_written_ingest,
    rows_written_observs: observationsResult.rows_written_observs,
    pages: observationsResult.pages,
    detail: {
      deleted_target_connector_ids: targetConnectorIds,
      reseed_lookback_hours: options.reseedLookbackHours,
      skip_delete: options.skipDelete,
      sequence_rows: sequenceRows,
      core_detail: coreResult.detail,
      observations_detail: observationsResult.detail,
    },
  };
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type, x-cron-secret",
      },
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
  }

  try {
    requireRuntimeConfig();

    const unauthorized = requireAuth(req);
    if (unauthorized) {
      return unauthorized;
    }

    const url = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    const mode = parseMode(
      (body as Record<string, unknown>).mode ??
        url.searchParams.get("mode") ??
        "observations",
    );

    const targetClient = buildClient(
      TARGET_SUPABASE_URL,
      TARGET_SB_SECRET_KEY,
      "uk_aq_sync_openaq_from_live",
    );
    const sourceClient = buildClient(
      SOURCE_SUPABASE_URL,
      SOURCE_SB_SECRET_KEY,
      "uk_aq_sync_openaq_from_live_source",
    );

    const lockRow = await acquireLock(targetClient, mode);

    if (!lockRow.acquired) {
      return jsonResponse({
        status: "skipped_locked",
        mode,
        lock: {
          owner: lockRow.lock_owner,
          expires_at: lockRow.lock_expires_at,
          last_status: lockRow.last_status,
          last_error: lockRow.last_error,
        },
      }, 202);
    }

    if (!lockRow.lock_owner) {
      throw new Error(`Lock owner not returned for ${mode}.`);
    }

    try {
      let result: SyncResult;
      if (mode === "observations") {
        const overlapMinutes = parseOptionalInt(
          (body as Record<string, unknown>).overlap_minutes ??
            url.searchParams.get("overlap_minutes"),
          DEFAULT_OBSERVATION_OVERLAP_MINUTES,
          0,
          120,
        );
        const initialLookbackHours = parseOptionalInt(
          (body as Record<string, unknown>).initial_lookback_hours ??
            url.searchParams.get("initial_lookback_hours"),
          DEFAULT_INITIAL_OBSERVATION_LOOKBACK_HOURS,
          1,
          720,
        );

        result = await runObservationsSync(
          sourceClient,
          targetClient,
          lockRow,
          {
            overlapMinutes,
            initialLookbackHours,
          },
        );

        await releaseLock(targetClient, mode, lockRow.lock_owner, {
          status: "success",
          cursorObservedAt:
            (result.detail.cursor_observed_at as string | null | undefined) ??
              null,
          cursorTimeseriesId:
            (result.detail.cursor_timeseries_id as number | null | undefined) ??
              null,
          rowsRead: result.rows_read,
          rowsWrittenIngest: result.rows_written_ingest,
          rowsWrittenObservs: result.rows_written_observs,
        });
      } else if (mode === "core") {
        const overlapMinutes = parseOptionalInt(
          (body as Record<string, unknown>).overlap_minutes ??
            url.searchParams.get("overlap_minutes"),
          DEFAULT_CORE_OVERLAP_MINUTES,
          0,
          1440,
        );
        const full = parseBoolean(
          (body as Record<string, unknown>).full ??
            url.searchParams.get("full"),
          false,
        );

        result = await runCoreSync(sourceClient, targetClient, lockRow, {
          overlapMinutes,
          full,
        });

        await releaseLock(targetClient, mode, lockRow.lock_owner, {
          status: "success",
          cursorCoreSyncedAt: result.finished_at,
          rowsRead: result.rows_read,
          rowsWrittenIngest: result.rows_written_ingest,
          rowsWrittenObservs: result.rows_written_observs,
        });
      } else {
        const confirm = String((body as Record<string, unknown>).confirm ?? "")
          .trim();
        if (confirm !== "RESEED_OPENAQ") {
          throw new Error(
            "Reseed mode requires body.confirm='RESEED_OPENAQ' to prevent accidental destructive reset.",
          );
        }

        const reseedLookbackHours = parseOptionalInt(
          (body as Record<string, unknown>).reseed_lookback_hours ??
            url.searchParams.get("reseed_lookback_hours"),
          DEFAULT_RESEED_LOOKBACK_HOURS,
          1,
          2160,
        );
        const skipDelete = parseBoolean(
          (body as Record<string, unknown>).skip_delete ??
            url.searchParams.get("skip_delete"),
          false,
        );

        result = await runReseed(sourceClient, targetClient, lockRow, {
          reseedLookbackHours,
          skipDelete,
        });

        await releaseLock(targetClient, mode, lockRow.lock_owner, {
          status: "success",
          rowsRead: result.rows_read,
          rowsWrittenIngest: result.rows_written_ingest,
          rowsWrittenObservs: result.rows_written_observs,
        });
      }

      return jsonResponse({ status: "ok", result });
    } catch (error) {
      await releaseLock(targetClient, mode, lockRow.lock_owner, {
        status: "failed",
        error: shortError(error),
      }).catch((releaseError) => {
        console.error("failed_to_release_lock", shortError(releaseError));
      });
      throw error;
    }
  } catch (error) {
    const message = shortError(error);
    console.error("uk_aq_sync_openaq_from_live_error", message);
    return jsonResponse(
      {
        status: "error",
        error: message,
      },
      500,
    );
  }
});
