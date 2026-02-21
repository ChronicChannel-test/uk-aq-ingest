import {
  createClient,
} from "https://esm.sh/@supabase/supabase-js@2.49.8";

type RpcError = { message: string };

type RpcResult<T> = {
  data: T | null;
  error: RpcError | null;
};

export type MainRpcCaller = <T>(
  fn: string,
  args?: Record<string, unknown>,
) => Promise<RpcResult<T>>;

export type HistoryObservationRow = {
  connector_id: number;
  timeseries_id: number;
  observed_at: string;
  value: number | null;
  status: string | null;
};

type HistoryOutboxClaimRow = {
  id: string;
  payload: unknown;
  attempts: number;
};

type HistoryOutboxResolveRow = {
  rows_resolved: number;
};

type HistoryOutboxEnqueueRow = {
  rows_enqueued: number;
};

type HistoryReceiptUpsertRow = {
  rows_upserted: number;
};

type HistoryUpsertRow = {
  observations_upserted: number;
};

export type HistorySyncReceiptRow = {
  connector_id: number;
  timeseries_id: number;
  observed_day: string;
};

export type HistoryOutboxFlushStats = {
  claimed: number;
  delivered: number;
  failed: number;
  receipts_upserted: number;
  rows_resolved: number;
};

export type HistoryWriteStats = {
  written: number;
  receipts_upserted: number;
  enqueued: number;
};

export type HistoryOutboxFlushOptions = {
  claim_batch_limit?: number;
};

type HistoryWriteMode = "direct" | "outbox_only" | "pubsub_only";

const HISTORY_SUPABASE_URL = (
  Deno.env.get("HISTORY_SUPABASE_URL") ?? ""
).trim();

const HISTORY_SECRET_KEY = (
  Deno.env.get("HISTORY_SECRET_KEY") ?? ""
).trim();

const HISTORY_SCHEMA = (
  Deno.env.get("HISTORY_SCHEMA") ??
    Deno.env.get("HISTORY_DB_SCHEMA") ??
    "uk_aq_public"
).trim();

function normalizeHistoryRpcSchema(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  // History RPC functions live in uk_aq_public. Accept older env values and
  // map them to the callable RPC schema.
  if (!normalized || normalized === "uk_aq_history" || normalized === "public") {
    return "uk_aq_public";
  }
  return raw.trim();
}

// RPC functions are defined in uk_aq_public, while tables live in uk_aq_history.
// Keep backward compatibility with HISTORY_DB_SCHEMA values that may point at table schema.
const HISTORY_RPC_SCHEMA = normalizeHistoryRpcSchema(HISTORY_SCHEMA);

const HISTORY_UPSERT_RPC = (Deno.env.get("HISTORY_UPSERT_RPC") ||
  "uk_aq_rpc_history_observations_upsert")
  .trim();

const HISTORY_OUTBOX_FLUSH_LIMIT = parsePositiveInt(
  Deno.env.get("HISTORY_OUTBOX_FLUSH_LIMIT"),
  40,
);

const HISTORY_UPSERT_CHUNK_SIZE = parsePositiveInt(
  Deno.env.get("HISTORY_UPSERT_CHUNK_SIZE"),
  5000,
);

const HISTORY_WRITE_MODE = normalizeHistoryWriteMode(
  Deno.env.get("HISTORY_WRITE_MODE"),
);

const GCP_PROJECT_ID = (
  Deno.env.get("GCP_PROJECT_ID") ??
    Deno.env.get("GOOGLE_CLOUD_PROJECT") ??
    ""
).trim();

const GCP_HISTORY_PUBSUB_TOPIC = (
  Deno.env.get("GCP_HISTORY_PUBSUB_TOPIC") ??
    ""
).trim();

const HISTORY_PUBSUB_PUBLISH_BATCH_SIZE = parsePositiveInt(
  Deno.env.get("HISTORY_PUBSUB_PUBLISH_BATCH_SIZE"),
  500,
);

let historyClientCache: ReturnType<typeof createClient> | null = null;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? "");
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.trunc(value));
}

function normalizeHistoryWriteMode(raw: string | undefined): HistoryWriteMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "direct") {
    return "direct";
  }
  if (value === "pubsub_only") {
    return "pubsub_only";
  }
  return "outbox_only";
}

function chunkRows<T>(rows: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let idx = 0; idx < rows.length; idx += chunkSize) {
    chunks.push(rows.slice(idx, idx + chunkSize));
  }
  return chunks;
}

function asFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asPositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const intValue = Math.trunc(parsed);
  return intValue > 0 ? intValue : null;
}

function toObservedAt(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function normalizeStatus(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const status = String(value).trim();
  return status ? status : null;
}

export function prepareHistoryRows(
  historyRows: HistoryObservationRow[],
): HistoryObservationRow[] {
  if (!historyRows.length) {
    return [];
  }
  const dedup = new Map<string, HistoryObservationRow>();
  for (const row of historyRows) {
    const connectorId = asPositiveInt(row.connector_id);
    const timeseriesId = asPositiveInt(row.timeseries_id);
    const observedAt = toObservedAt(row.observed_at);
    if (connectorId === null || timeseriesId === null || !observedAt) {
      continue;
    }
    const key = `${connectorId}:${timeseriesId}:${observedAt}`;
    dedup.set(key, {
      connector_id: connectorId,
      timeseries_id: timeseriesId,
      observed_at: observedAt,
      value: asFiniteNumber(row.value),
      status: normalizeStatus(row.status),
    });
  }
  return Array.from(dedup.values());
}

function toObservedDay(value: unknown): string | null {
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

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 400 ? `${message.slice(0, 397)}...` : message;
}

function pubsubTopicPath(): string {
  if (!GCP_HISTORY_PUBSUB_TOPIC) {
    return "";
  }
  if (GCP_HISTORY_PUBSUB_TOPIC.startsWith("projects/")) {
    return GCP_HISTORY_PUBSUB_TOPIC;
  }
  if (!GCP_PROJECT_ID) {
    return "";
  }
  return `projects/${GCP_PROJECT_ID}/topics/${GCP_HISTORY_PUBSUB_TOPIC}`;
}

function historyPubsubConfigured(): boolean {
  return Boolean(pubsubTopicPath());
}

async function fetchGoogleAccessToken(): Promise<string> {
  const response = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    {
      headers: { "Metadata-Flavor": "Google" },
    },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Metadata token request failed (${response.status}): ${text}`,
    );
  }
  const payload = await response.json().catch(() => null);
  const token = typeof payload?.access_token === "string"
    ? payload.access_token.trim()
    : "";
  if (!token) {
    throw new Error("Metadata token response missing access_token");
  }
  return token;
}

type PubsubPublishResponse = {
  messageIds?: unknown;
};

async function publishHistoryRowsToPubsub(
  preparedRows: HistoryObservationRow[],
): Promise<number> {
  if (!preparedRows.length) {
    return 0;
  }
  const topicPath = pubsubTopicPath();
  if (!topicPath) {
    throw new Error(
      "History Pub/Sub is not configured (missing GCP_HISTORY_PUBSUB_TOPIC or GCP_PROJECT_ID).",
    );
  }

  const token = await fetchGoogleAccessToken();
  let published = 0;

  for (const chunk of chunkRows(preparedRows, HISTORY_PUBSUB_PUBLISH_BATCH_SIZE)) {
    const messages = chunk.map((row) => ({
      data: btoa(JSON.stringify(row)),
      attributes: {
        connector_id: String(row.connector_id),
        timeseries_id: String(row.timeseries_id),
        observed_at: row.observed_at,
      },
    }));

    const response = await fetch(
      `https://pubsub.googleapis.com/v1/${topicPath}:publish`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages }),
      },
    );

    const payload = await response.json().catch(() => null) as PubsubPublishResponse | null;
    if (!response.ok) {
      const message = typeof payload === "object" && payload !== null
        ? JSON.stringify(payload)
        : `HTTP ${response.status}`;
      throw new Error(`History Pub/Sub publish failed: ${message}`);
    }
    const messageIds = payload?.messageIds;
    published += Array.isArray(messageIds)
      ? messageIds.length
      : chunk.length;
  }

  return published;
}

function countRowsFromPayload<T extends string>(
  payload: Array<Record<T, number>> | null,
  field: T,
  fallback: number,
): number {
  const value = Number(payload?.[0]?.[field] ?? fallback);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function historyConfigured(): boolean {
  return Boolean(HISTORY_SUPABASE_URL && HISTORY_SECRET_KEY);
}

export function createSupabaseHistoryClient(): ReturnType<typeof createClient> {
  if (!historyConfigured()) {
    throw new Error(
      "History client is not configured (missing HISTORY_SUPABASE_URL or HISTORY_SECRET_KEY)",
    );
  }
  if (!historyClientCache) {
    const schema = HISTORY_RPC_SCHEMA || "uk_aq_public";
    historyClientCache = createClient(
      HISTORY_SUPABASE_URL,
      HISTORY_SECRET_KEY,
      ({
        auth: { persistSession: false, autoRefreshToken: false },
        db: { schema: schema as never },
        global: {
          headers: {
            "X-Client-Info": "uk-aq-ingest-history-dualwrite",
          },
        },
      }) as never,
    );
  }
  return historyClientCache;
}

export async function historyUpsertObservations(
  historyRows: HistoryObservationRow[],
): Promise<number> {
  const preparedRows = prepareHistoryRows(historyRows);
  if (!preparedRows.length) {
    return 0;
  }

  const history = createSupabaseHistoryClient();
  let written = 0;

  for (const chunk of chunkRows(preparedRows, HISTORY_UPSERT_CHUNK_SIZE)) {
    const { data, error } = await history.rpc(HISTORY_UPSERT_RPC, {
      rows: chunk,
    });
    if (error) {
      throw new Error(`History upsert failed: ${error.message}`);
    }
    written += countRowsFromPayload(
      (Array.isArray(data) ? data : null) as
        | Array<Record<"observations_upserted", number>>
        | null,
      "observations_upserted",
      chunk.length,
    );
  }

  return written;
}

export function buildHistorySyncReceipts(
  rows: Array<
    Pick<
      HistoryObservationRow,
      "connector_id" | "timeseries_id" | "observed_at"
    >
  >,
): HistorySyncReceiptRow[] {
  const dedup = new Map<string, HistorySyncReceiptRow>();
  for (const row of rows) {
    const connectorId = asFiniteNumber(row.connector_id);
    const timeseriesId = asFiniteNumber(row.timeseries_id);
    const observedDay = toObservedDay(row.observed_at);
    if (connectorId === null || timeseriesId === null || !observedDay) {
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

export async function upsertHistorySyncReceipts(
  mainRpc: MainRpcCaller,
  rows: HistorySyncReceiptRow[],
): Promise<number> {
  if (!rows.length) {
    return 0;
  }
  const { data, error } = await mainRpc<HistoryReceiptUpsertRow[]>(
    "uk_aq_rpc_history_sync_receipt_daily_upsert",
    { rows },
  );
  if (error) {
    throw new Error(`History receipt upsert failed: ${error.message}`);
  }
  return countRowsFromPayload(
    data as Array<Record<"rows_upserted", number>> | null,
    "rows_upserted",
    rows.length,
  );
}

export async function enqueueHistoryOutbox(
  mainRpc: MainRpcCaller,
  historyRows: HistoryObservationRow[],
): Promise<number> {
  const preparedRows = prepareHistoryRows(historyRows);
  if (!preparedRows.length) {
    return 0;
  }
  const { data, error } = await mainRpc<HistoryOutboxEnqueueRow[]>(
    "uk_aq_rpc_history_outbox_enqueue",
    {
      entries: [{ payload: preparedRows }],
    },
  );
  if (error) {
    throw new Error(`History outbox enqueue failed: ${error.message}`);
  }
  return countRowsFromPayload(
    data as Array<Record<"rows_enqueued", number>> | null,
    "rows_enqueued",
    1,
  );
}

export async function writeHistoryWithOutbox(
  mainRpc: MainRpcCaller,
  historyRows: HistoryObservationRow[],
  onWarning?: (message: string) => void,
): Promise<HistoryWriteStats> {
  const preparedRows = prepareHistoryRows(historyRows);
  if (!preparedRows.length) {
    return { written: 0, receipts_upserted: 0, enqueued: 0 };
  }

  if (HISTORY_WRITE_MODE === "outbox_only") {
    const enqueued = await enqueueHistoryOutbox(mainRpc, preparedRows);
    return {
      written: 0,
      receipts_upserted: 0,
      enqueued,
    };
  }

  if (HISTORY_WRITE_MODE === "pubsub_only") {
    if (!historyPubsubConfigured()) {
      throw new Error(
        "HISTORY_WRITE_MODE=pubsub_only but Pub/Sub is not configured.",
      );
    }
    const enqueued = await publishHistoryRowsToPubsub(preparedRows);
    return {
      written: 0,
      receipts_upserted: 0,
      enqueued,
    };
  }

  if (!historyConfigured()) {
    onWarning?.("History DB is not configured; skipping history write.");
    return { written: 0, receipts_upserted: 0, enqueued: 0 };
  }

  try {
    const written = await historyUpsertObservations(preparedRows);
    const receipts = buildHistorySyncReceipts(preparedRows);
    const receiptsUpserted = await upsertHistorySyncReceipts(mainRpc, receipts);
    return {
      written,
      receipts_upserted: receiptsUpserted,
      enqueued: 0,
    };
  } catch (error) {
    const enqueued = await enqueueHistoryOutbox(mainRpc, preparedRows);
    onWarning?.(`History write failed, queued to outbox: ${shortError(error)}`);
    return {
      written: 0,
      receipts_upserted: 0,
      enqueued,
    };
  }
}

export async function flushHistoryOutbox(
  mainRpc: MainRpcCaller,
  onWarning?: (message: string) => void,
  options: HistoryOutboxFlushOptions = {},
): Promise<HistoryOutboxFlushStats> {
  const stats: HistoryOutboxFlushStats = {
    claimed: 0,
    delivered: 0,
    failed: 0,
    receipts_upserted: 0,
    rows_resolved: 0,
  };

  if (!historyConfigured()) {
    return stats;
  }

  const claimResult = await mainRpc<HistoryOutboxClaimRow[]>(
    "uk_aq_rpc_history_outbox_claim",
    {
      batch_limit: (() => {
        const candidate = Number(options.claim_batch_limit);
        if (Number.isFinite(candidate) && candidate > 0) {
          return Math.max(1, Math.trunc(candidate));
        }
        return HISTORY_OUTBOX_FLUSH_LIMIT;
      })(),
    },
  );

  if (claimResult.error) {
    onWarning?.(`History outbox claim failed: ${claimResult.error.message}`);
    return stats;
  }

  const claimedRows = claimResult.data ?? [];
  stats.claimed = claimedRows.length;
  if (!claimedRows.length) {
    return stats;
  }

  const resolutions: Array<{
    id: string;
    ok: boolean;
    error?: string;
  }> = [];
  const deliveryRows: HistoryObservationRow[] = [];
  const deliveryIds: string[] = [];

  for (const row of claimedRows) {
    const payloadRows = Array.isArray(row.payload)
      ? row.payload as HistoryObservationRow[]
      : [];
    const preparedRows = prepareHistoryRows(payloadRows);
    if (!preparedRows.length) {
      resolutions.push({ id: row.id, ok: true });
      continue;
    }
    deliveryRows.push(...preparedRows);
    deliveryIds.push(row.id);
  }

  if (deliveryIds.length > 0) {
    const mergedRows = prepareHistoryRows(deliveryRows);
    try {
      const delivered = await historyUpsertObservations(mergedRows);
      stats.delivered += delivered;
      const receipts = buildHistorySyncReceipts(mergedRows);
      stats.receipts_upserted += await upsertHistorySyncReceipts(
        mainRpc,
        receipts,
      );
      for (const id of deliveryIds) {
        resolutions.push({ id, ok: true });
      }
    } catch (error) {
      const message = shortError(error);
      stats.failed += deliveryIds.length;
      for (const id of deliveryIds) {
        resolutions.push({
          id,
          ok: false,
          error: message,
        });
      }
      onWarning?.(
        `History outbox batch delivery failed for ${deliveryIds.length} entries: ${message}`,
      );
    }
  }

  const resolveResult = await mainRpc<HistoryOutboxResolveRow[]>(
    "uk_aq_rpc_history_outbox_resolve",
    { resolutions },
  );

  if (resolveResult.error) {
    onWarning?.(
      `History outbox resolve failed: ${resolveResult.error.message}`,
    );
    return stats;
  }

  stats.rows_resolved = countRowsFromPayload(
    resolveResult.data as Array<Record<"rows_resolved", number>> | null,
    "rows_resolved",
    resolutions.length,
  );

  return stats;
}
