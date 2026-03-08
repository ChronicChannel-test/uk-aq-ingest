import "../../supabase/functions/_shared/fetch_egress_patch.ts";

import {
  flushObservsOutbox,
  type ObservsOutboxFlushStats,
  type MainRpcCaller,
} from "../../supabase/functions/_shared/observs_client.ts";

type RpcError = { message: string };

type RpcResult<T> = {
  data: T | null;
  error: RpcError | null;
};

type FlushSummary = ObservsOutboxFlushStats & {
  batches: number;
  max_batches: number;
  warnings: string[];
  stop_reason?: string;
  stopped_early?: boolean;
  errors: string[];
};

const SUPABASE_URL = requiredEnv("SUPABASE_URL");
const SUPABASE_PRIVILEGED_KEY = requiredEnvAny(["SB_SECRET_KEY"]);
const OBS_AQIDB_SUPABASE_URL = (Deno.env.get("OBS_AQIDB_SUPABASE_URL") || "").trim();
const OBS_AQIDB_SECRET_KEY = (
  Deno.env.get("OBS_AQIDB_SECRET_KEY") ?? ""
).trim();
const MAIN_RPC_SCHEMA = (Deno.env.get("UK_AQ_PUBLIC_SCHEMA") || "uk_aq_public")
  .trim();

const FLUSH_MAX_BATCHES = parsePositiveInt(
  Deno.env.get("OBSERVS_OUTBOX_CLOUD_RUN_MAX_BATCHES"),
  30,
);
const FLUSH_BUDGET_SECONDS = parsePositiveInt(
  Deno.env.get("OBSERVS_OUTBOX_CLOUD_RUN_BUDGET_SECONDS"),
  540,
);
const FLUSH_SHUTDOWN_BUFFER_SECONDS = parsePositiveInt(
  Deno.env.get("OBSERVS_OUTBOX_CLOUD_RUN_SHUTDOWN_BUFFER_SECONDS"),
  20,
);
const MAIN_RPC_RETRIES = parsePositiveInt(
  Deno.env.get("OBSERVS_OUTBOX_CLOUD_RUN_RPC_RETRIES"),
  3,
);
const CLAIM_BATCH_LIMIT = parsePositiveInt(
  Deno.env.get("OBSERVS_OUTBOX_CLOUD_RUN_CLAIM_BATCH_LIMIT"),
  20,
);
const MIN_BATCH_BUDGET_MS = 4000;
const REST_BASE_URL = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1`;

function requiredEnv(name: string): string {
  const value = (Deno.env.get(name) || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requiredEnvAny(names: string[]): string {
  for (const name of names) {
    const value = (Deno.env.get(name) || "").trim();
    if (value) {
      return value;
    }
  }
  throw new Error(
    `Missing required environment variable: one of ${names.join(", ")}`,
  );
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw || "");
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 ||
    status === 504;
}

async function mainRpc<T>(
  fn: string,
  args?: Record<string, unknown>,
): Promise<RpcResult<T>> {
  const url = `${REST_BASE_URL}/rpc/${fn}`;
  const headers: Record<string, string> = {
    apikey: SUPABASE_PRIVILEGED_KEY,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Profile": MAIN_RPC_SCHEMA,
    "Content-Profile": MAIN_RPC_SCHEMA,
    "x-ukaq-egress-caller": "uk_aq_observs_outbox_cloud_run",
  };

  for (let attempt = 1; attempt <= MAIN_RPC_RETRIES; attempt += 1) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(args ?? {}),
      });
      const contentType = (resp.headers.get("content-type") || "").toLowerCase();
      const payload = contentType.includes("application/json")
        ? await resp.json().catch(() => null)
        : await resp.text().catch(() => null);

      if (resp.ok) {
        return { data: payload as T, error: null };
      }

      const message = payload?.message || payload?.error_description ||
        payload?.error || resp.statusText || `HTTP ${resp.status}`;
      if (attempt < MAIN_RPC_RETRIES && isRetryableStatus(resp.status)) {
        await sleep(Math.min(5000, 1000 * attempt));
        continue;
      }
      return { data: null, error: { message: String(message) } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < MAIN_RPC_RETRIES) {
        await sleep(Math.min(5000, 1000 * attempt));
        continue;
      }
      return { data: null, error: { message } };
    }
  }

  return { data: null, error: { message: "unknown_main_rpc_error" } };
}

function observsConfigured(): boolean {
  return Boolean(OBS_AQIDB_SUPABASE_URL && OBS_AQIDB_SECRET_KEY);
}

function buildEmptySummary(): FlushSummary {
  return {
    batches: 0,
    max_batches: FLUSH_MAX_BATCHES,
    claimed: 0,
    delivered: 0,
    failed: 0,
    receipts_upserted: 0,
    rows_resolved: 0,
    warnings: [],
    errors: [],
  };
}

function getRemainingBudgetMs(startedAtMs: number): number {
  return Math.max(
    0,
    FLUSH_BUDGET_SECONDS * 1000 -
      (Date.now() - startedAtMs) -
      FLUSH_SHUTDOWN_BUFFER_SECONDS * 1000,
  );
}

function hasSevereWarning(warnings: string[]): boolean {
  return warnings.some((message) => {
    const text = message.toLowerCase();
    return text.includes("claim failed") || text.includes("resolve failed");
  });
}

function summarizeForError(summary: FlushSummary): string {
  const payload = {
    batches: summary.batches,
    max_batches: summary.max_batches,
    claimed: summary.claimed,
    delivered: summary.delivered,
    failed: summary.failed,
    rows_resolved: summary.rows_resolved,
    warnings: summary.warnings.slice(0, 3),
    stop_reason: summary.stop_reason || null,
  };
  return JSON.stringify(payload);
}

async function flushObservsOutboxInBudget(): Promise<FlushSummary> {
  const summary = buildEmptySummary();
  if (!observsConfigured()) {
    summary.stop_reason = "observs_not_configured";
    return summary;
  }

  const startedAtMs = Date.now();
  for (let idx = 0; idx < FLUSH_MAX_BATCHES; idx += 1) {
    if (getRemainingBudgetMs(startedAtMs) < MIN_BATCH_BUDGET_MS) {
      summary.stopped_early = true;
      summary.stop_reason = "runtime_budget";
      break;
    }

    const batchWarnings: string[] = [];
    const stats = await flushObservsOutbox(
      mainRpc as MainRpcCaller,
      (message) => {
        batchWarnings.push(message);
        console.warn("observs_outbox_flush_warning", { message });
      },
      { claim_batch_limit: CLAIM_BATCH_LIMIT },
    );

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
      summary.stop_reason = "queue_empty";
      break;
    }
    if (stats.failed > 0 && stats.delivered === 0) {
      summary.stopped_early = true;
      summary.stop_reason = "all_failed_batch";
      break;
    }
  }

  return summary;
}

async function main(): Promise<void> {
  const now = new Date().toISOString();
  console.log("observs_outbox_cloud_run_start", {
    checked_at: now,
    max_batches: FLUSH_MAX_BATCHES,
    claim_batch_limit: CLAIM_BATCH_LIMIT,
    budget_seconds: FLUSH_BUDGET_SECONDS,
    shutdown_buffer_seconds: FLUSH_SHUTDOWN_BUFFER_SECONDS,
  });

  const summary = await flushObservsOutboxInBudget();
  console.log("observs_outbox_cloud_run_summary", {
    checked_at: now,
    observs_outbox: summary,
  });

  if (summary.errors.length > 0) {
    throw new Error(`observs_outbox_flush_error ${summarizeForError(summary)}`);
  }
  if (summary.claimed > 0 && summary.rows_resolved === 0) {
    throw new Error(
      `observs_outbox_flush_no_resolve ${summarizeForError(summary)}`,
    );
  }
  if (summary.claimed === 0 && hasSevereWarning(summary.warnings)) {
    throw new Error(
      `observs_outbox_flush_claim_or_resolve_warning ${summarizeForError(summary)}`,
    );
  }
}

if (import.meta.main) {
  await main();
}
