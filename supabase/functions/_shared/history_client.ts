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
  connector_code: string;
  service_ref: string;
  timeseries_ref: string;
  observed_at: string;
  value: number | null;
  status: string | null;
  connector_id?: number;
  timeseries_id?: number;
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

const HISTORY_SUPABASE_URL = (
  Deno.env.get("HISTORY_SUPABASE_URL") ?? ""
).trim();

const HISTORY_SERVICE_ROLE_KEY = (
  Deno.env.get("HISTORY_SERVICE_ROLE_KEY") ?? ""
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
  20,
);

const HISTORY_UPSERT_CHUNK_SIZE = parsePositiveInt(
  Deno.env.get("HISTORY_UPSERT_CHUNK_SIZE"),
  2000,
);

let historyClientCache: ReturnType<typeof createClient> | null = null;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? "");
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.trunc(value));
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
  return Boolean(HISTORY_SUPABASE_URL && HISTORY_SERVICE_ROLE_KEY);
}

export function createSupabaseHistoryClient(): ReturnType<typeof createClient> {
  if (!historyConfigured()) {
    throw new Error(
      "History client is not configured (missing HISTORY_SUPABASE_URL or HISTORY_SERVICE_ROLE_KEY)",
    );
  }
  if (!historyClientCache) {
    const schema = HISTORY_RPC_SCHEMA || "uk_aq_public";
    historyClientCache = createClient(
      HISTORY_SUPABASE_URL,
      HISTORY_SERVICE_ROLE_KEY,
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
  if (!historyRows.length) {
    return 0;
  }

  const history = createSupabaseHistoryClient();
  let written = 0;

  for (const chunk of chunkRows(historyRows, HISTORY_UPSERT_CHUNK_SIZE)) {
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
  if (!historyRows.length) {
    return 0;
  }
  const { data, error } = await mainRpc<HistoryOutboxEnqueueRow[]>(
    "uk_aq_rpc_history_outbox_enqueue",
    {
      entries: [{ payload: historyRows }],
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
  if (!historyRows.length) {
    return { written: 0, receipts_upserted: 0, enqueued: 0 };
  }
  if (!historyConfigured()) {
    onWarning?.("History DB is not configured; skipping history write.");
    return { written: 0, receipts_upserted: 0, enqueued: 0 };
  }

  try {
    const written = await historyUpsertObservations(historyRows);
    const receipts = buildHistorySyncReceipts(historyRows);
    const receiptsUpserted = await upsertHistorySyncReceipts(mainRpc, receipts);
    return {
      written,
      receipts_upserted: receiptsUpserted,
      enqueued: 0,
    };
  } catch (error) {
    const enqueued = await enqueueHistoryOutbox(mainRpc, historyRows);
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

  for (const row of claimedRows) {
    const payloadRows = Array.isArray(row.payload)
      ? row.payload as HistoryObservationRow[]
      : [];

    if (!payloadRows.length) {
      resolutions.push({ id: row.id, ok: true });
      continue;
    }

    try {
      const delivered = await historyUpsertObservations(payloadRows);
      stats.delivered += delivered;
      const receipts = buildHistorySyncReceipts(payloadRows);
      stats.receipts_upserted += await upsertHistorySyncReceipts(
        mainRpc,
        receipts,
      );
      resolutions.push({ id: row.id, ok: true });
    } catch (error) {
      stats.failed += 1;
      resolutions.push({
        id: row.id,
        ok: false,
        error: shortError(error),
      });
      onWarning?.(
        `History outbox delivery failed for ${row.id}: ${shortError(error)}`,
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
