import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import "../_shared/fetch_egress_patch.ts";
import {
  flushHistoryOutbox,
  type HistoryOutboxFlushStats,
} from "../_shared/history_client.ts";

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
const SB_UK_AQ_CRON_SECRET = Deno.env.get("SB_UK_AQ_CRON_SECRET") ?? "";
const UK_AQ_CORE_SCHEMA = Deno.env.get("UK_AQ_CORE_SCHEMA") ?? "uk_aq_core";

const REST_BASE_URL = SUPABASE_URL
  ? `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1`
  : "";

const HISTORY_OUTBOX_FLUSH_MAX_BATCHES = parsePositiveInt(
  Deno.env.get("HISTORY_OUTBOX_FLUSH_MAX_BATCHES") ??
    Deno.env.get("HISTORY_OUTBOX_DISPATCH_MAX_FLUSHES"),
  3,
);
const MIN_FLUSH_BUDGET_MS = 5000;
const FLUSH_TIME_BUDGET_MS = parseMillisecondsSetting(
  Deno.env.get("HISTORY_OUTBOX_FLUSH_TIME_BUDGET_MS"),
  120000,
  MIN_FLUSH_BUDGET_MS,
);
const FLUSH_SHUTDOWN_BUFFER_MS = parseMillisecondsSetting(
  Deno.env.get("HISTORY_OUTBOX_FLUSH_SHUTDOWN_BUFFER_MS"),
  5000,
  1000,
);
const FLUSH_EFFECTIVE_SHUTDOWN_BUFFER_MS = Math.min(
  FLUSH_SHUTDOWN_BUFFER_MS,
  Math.max(0, FLUSH_TIME_BUDGET_MS - MIN_FLUSH_BUDGET_MS),
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
    "x-ukaq-egress-caller": "uk_aq_flush_history_outbox",
  };
  if (schema && schema !== "public") {
    headers["Accept-Profile"] = schema;
    headers["Content-Profile"] = schema;
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

function jsonResponse(
  payload: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function postgrestRequest<T>(
  method: string,
  table: string,
  body?: unknown,
  schema?: string,
): Promise<{ data: T | null; error: { message: string } | null }> {
  if (!REST_BASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return {
      data: null,
      error: { message: "Missing REST_BASE_URL or SUPABASE_SERVICE_ROLE_KEY." },
    };
  }
  const url = `${REST_BASE_URL}/${table}`;
  const resp = await fetch(url, {
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

async function publicRpcRequest<T>(
  fn: string,
  args?: Record<string, unknown>,
): Promise<{ data: T | null; error: { message: string } | null }> {
  return await postgrestRequest<T>(
    "POST",
    `rpc/${fn}`,
    args ?? {},
    "uk_aq_public",
  );
}

function getFlushRemainingMs(flushStartedAtMs: number): number {
  return Math.max(
    0,
    FLUSH_TIME_BUDGET_MS - (Date.now() - flushStartedAtMs) -
      FLUSH_EFFECTIVE_SHUTDOWN_BUFFER_MS,
  );
}

function isFlushBudgetRemaining(flushStartedAtMs: number): boolean {
  return getFlushRemainingMs(flushStartedAtMs) >= MIN_FLUSH_BUDGET_MS;
}

function emptyHistoryOutboxDrainSummary(): HistoryOutboxDrainSummary {
  return {
    batches: 0,
    max_batches: HISTORY_OUTBOX_FLUSH_MAX_BATCHES,
    claimed: 0,
    delivered: 0,
    failed: 0,
    receipts_upserted: 0,
    rows_resolved: 0,
    warnings: [],
  };
}

async function drainHistoryOutbox(
  flushStartedAtMs: number,
): Promise<HistoryOutboxDrainSummary> {
  const summary = emptyHistoryOutboxDrainSummary();
  for (let idx = 0; idx < HISTORY_OUTBOX_FLUSH_MAX_BATCHES; idx += 1) {
    if (!isFlushBudgetRemaining(flushStartedAtMs)) {
      summary.stopped_early = true;
      summary.stop_reason = "flush_time_budget";
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
    if (stats.failed > 0 && stats.delivered === 0) {
      break;
    }
  }
  return summary;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const authResponse = requireCronSecret(req);
  if (authResponse) {
    return authResponse;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({
      error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.",
    }, 500);
  }

  const flushStartedAtMs = Date.now();
  const now = new Date();
  const summary = await drainHistoryOutbox(flushStartedAtMs).catch((error) => {
    const fallback = emptyHistoryOutboxDrainSummary();
    fallback.error = error instanceof Error ? error.message : String(error);
    console.warn("history_outbox_flush_failed", {
      error: fallback.error,
    });
    return fallback;
  });

  return jsonResponse({
    checked_at: now.toISOString(),
    history_outbox: summary,
  });
});
