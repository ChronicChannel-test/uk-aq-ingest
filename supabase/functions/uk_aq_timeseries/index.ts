//trigger deploy 2026-02-09 13:34
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import "../_shared/fetch_egress_patch.ts";
import { cacheControlHeaders, CACHE_CONTROL_SUCCESS_SMAXAGE_300 } from "../_shared/cache.ts";
import { createWeakEtag, ifNoneMatchMatches } from "../_shared/etag.ts";
import { logEndpointEgress } from "../_shared/egress_metrics.ts";

const DEFAULT_WINDOW = "24h";
const DEFAULT_FORMAT = "objects";

const WINDOW_HOURS: Record<string, number> = {
  "12h": 12,
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")
  ?? Deno.env.get("SB_SUPABASE_URL")
  ?? "";
const SB_SECRET_KEY = Deno.env.get("SB_SECRET_KEY") ?? "";
const SUPABASE_PRIVILEGED_KEY = SB_SECRET_KEY;
const UK_AQ_CORE_SCHEMA = Deno.env.get("UK_AQ_CORE_SCHEMA")
  ?? "uk_aq_core";
const UK_AQ_PUBLIC_SCHEMA = Deno.env.get("UK_AQ_PUBLIC_SCHEMA")
  ?? "uk_aq_public";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, if-none-match",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers": "ETag",
};

const REST_BASE_URL = SUPABASE_URL
  ? `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1`
  : "";

function postgrestHeaders(schema = UK_AQ_CORE_SCHEMA): Record<string, string> {
  const headers: Record<string, string> = {
    apikey: SUPABASE_PRIVILEGED_KEY,
    "Content-Type": "application/json",
    "x-ukaq-egress-caller": "uk_aq_timeseries",
  };
  if (schema && schema !== "public") {
    headers["Accept-Profile"] = schema;
    headers["Content-Profile"] = schema;
  }
  return headers;
}

async function postgrestRequest<T>(
  method: string,
  path: string,
  params?: Record<string, string>,
  schema?: string,
  body?: unknown,
): Promise<{ data: T | null; error: { message: string } | null }> {
  if (!REST_BASE_URL || !SUPABASE_PRIVILEGED_KEY) {
    return { data: null, error: { message: "Missing SUPABASE_URL or SB_SECRET_KEY." } };
  }
  const url = new URL(`${REST_BASE_URL}/${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const resp = await fetch(url.toString(), {
    method,
    headers: postgrestHeaders(schema),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = resp.headers.get("content-type") ?? "";
  const payload: any = contentType.includes("application/json") ? await resp.json() : await resp.text();
  if (!resp.ok) {
    const message = payload?.message || payload?.error_description || payload?.error || resp.statusText;
    return { data: null, error: { message: String(message) } };
  }
  return { data: payload as T, error: null };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS_HEADERS,
        "Access-Control-Max-Age": "86400",
        ...cacheControlHeaders(204, CACHE_CONTROL_SUCCESS_SMAXAGE_300),
      },
    });
  }
  if (req.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...CORS_HEADERS, ...cacheControlHeaders(405, CACHE_CONTROL_SUCCESS_SMAXAGE_300) },
    });
  }
  const startedAtMs = Date.now();
  const finish = (response: Response, fields: Record<string, unknown> = {}) =>
    logEndpointEgress(req, "uk_aq_timeseries", startedAtMs, response, fields);
  if (!SUPABASE_URL || !SUPABASE_PRIVILEGED_KEY) {
    return await finish(json({ error: "Missing SUPABASE_URL or SB_SECRET_KEY." }, 500), {
      error_type: "missing_env",
    });
  }

  const url = new URL(req.url);
  const timeseriesId = parseId(url.searchParams.get("timeseries_id"));
  if (!timeseriesId) {
    return await finish(json({ error: "Missing or invalid timeseries_id." }, 400), {
      error_type: "invalid_timeseries_id",
    });
  }
  const windowLabel = normalizeWindow(url.searchParams.get("window"));
  const rawLimit = url.searchParams.get("limit");
  const limit = parseOptionalLimit(rawLimit);
  if (rawLimit !== null && limit === null) {
    return await finish(json({ error: "Invalid limit. Provide a positive integer or omit limit." }, 400), {
      error_type: "invalid_limit",
    });
  }
  const rawSince = url.searchParams.get("since");
  const since = rawSince === null ? null : normalizeTimestamp(rawSince);
  if (rawSince !== null && since === null) {
    return await finish(
      json({ error: "Invalid since timestamp. Provide ISO-8601 datetime (e.g. 2026-02-07T10:30:00Z)." }, 400),
      { error_type: "invalid_since" },
    );
  }
  const rawFormat = url.searchParams.get("format");
  const responseFormat = normalizeFormat(rawFormat);
  if (rawFormat !== null && responseFormat === null) {
    return await finish(json({ error: "Invalid format. Use 'objects' or 'compact'." }, 400), {
      error_type: "invalid_format",
    });
  }
  const rawIncludeStatus = url.searchParams.get("include_status");
  const includeStatusParsed = parseBooleanParam(rawIncludeStatus);
  if (rawIncludeStatus !== null && includeStatusParsed === null) {
    return await finish(json({ error: "Invalid include_status. Use true/false." }, 400), {
      error_type: "invalid_include_status",
    });
  }
  const includeStatus = includeStatusParsed ?? true;
  const format = responseFormat ?? DEFAULT_FORMAT;
  const hours = WINDOW_HOURS[windowLabel] ?? WINDOW_HOURS[DEFAULT_WINDOW];
  const ifNoneMatch = req.headers.get("if-none-match");
  const requestFields = {
    timeseries_id: timeseriesId,
    window: windowLabel,
    limit: limit ?? null,
    has_since: Boolean(since),
    include_status: includeStatus,
    format,
    has_if_none_match: Boolean(ifNoneMatch),
  };

  const end = new Date();
  const startTime = new Date(end.getTime() - hours * 60 * 60 * 1000);
  try {
    const { data, error } = await callTimeseriesRpc({
      timeseriesId,
      windowLabel,
      limit,
      since,
      includeStatus,
    });
    if (error) {
      throw new Error(error.message);
    }
    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    const rows = normalizeTimeseriesRows(Array.isArray(row?.data) ? row.data : [], includeStatus);
    const nextSince = maxObservedTimestamp(rows, since);
    const columns = timeseriesColumns(includeStatus);
    const payload = {
      timeseries_id: row?.timeseries_id ?? timeseriesId,
      window: row?.window ?? windowLabel,
      start: row?.start ?? startTime.toISOString(),
      end: row?.end ?? end.toISOString(),
      since,
      next_since: nextSince,
      include_status: includeStatus,
      data_format: format,
      columns,
      count: row?.count ?? rows.length,
      guideline: row?.guideline ?? null,
      data: shapeTimeseriesData(rows, format, includeStatus),
    };
    const etag = await createWeakEtag({
      endpoint: "uk_aq_timeseries",
      version: 2,
      payload: etagPayload(payload),
    });
    if (ifNoneMatchMatches(ifNoneMatch, etag)) {
      return await finish(notModified(etag), { ...requestFields, result: "not_modified" });
    }
    return await finish(json(payload, 200, { ETag: etag }), {
      ...requestFields,
      result: "ok",
      row_count: rows.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await finish(json({ error: message }, 500), { ...requestFields, error_type: "runtime" });
  }
});

function parseId(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.floor(parsed);
}

type TimeseriesRpcCallOptions = {
  timeseriesId: number;
  windowLabel: string;
  limit: number | null;
  since: string | null;
  includeStatus: boolean;
};

async function callTimeseriesRpc(
  { timeseriesId, windowLabel, limit, since, includeStatus }: TimeseriesRpcCallOptions,
) {
  const withStatusArg = await postgrestRequest<any[]>(
    "POST",
    "rpc/uk_aq_timeseries_rpc",
    undefined,
    UK_AQ_PUBLIC_SCHEMA,
    {
      timeseries_id: timeseriesId,
      window_label: windowLabel,
      limit_rows: limit,
      since_ts: since,
      include_status: includeStatus,
    },
  );
  if (!withStatusArg.error) {
    return withStatusArg;
  }
  if (!looksLikeTimeseriesSignatureMismatch(withStatusArg.error.message)) {
    return withStatusArg;
  }
  return await postgrestRequest<any[]>(
    "POST",
    "rpc/uk_aq_timeseries_rpc",
    undefined,
    UK_AQ_PUBLIC_SCHEMA,
    {
      timeseries_id: timeseriesId,
      window_label: windowLabel,
      limit_rows: limit,
      since_ts: since,
    },
  );
}

function looksLikeTimeseriesSignatureMismatch(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return normalized.includes("could not find the function") &&
    normalized.includes("uk_aq_timeseries_rpc");
}

function normalizeWindow(value: string | null): string {
  if (!value) {
    return DEFAULT_WINDOW;
  }
  const trimmed = value.trim();
  return WINDOW_HOURS[trimmed] ? trimmed : DEFAULT_WINDOW;
}

function normalizeFormat(value: string | null): "objects" | "compact" | null {
  if (!value) {
    return DEFAULT_FORMAT;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "objects" || normalized === "object") {
    return "objects";
  }
  if (normalized === "compact" || normalized === "array" || normalized === "arrays") {
    return "compact";
  }
  return null;
}

function parseBooleanParam(value: string | null): boolean | null {
  if (value === null) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

function parseOptionalLimit(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }
  return Math.floor(parsed);
}

function normalizeTimestamp(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function maxObservedTimestamp(rows: any[], fallback: string | null): string | null {
  let best = fallback ? normalizeTimestamp(fallback) : null;
  let bestMs = best ? Date.parse(best) : Number.NEGATIVE_INFINITY;
  rows.forEach((row) => {
    const observedAt = row?.observed_at;
    if (!observedAt) {
      return;
    }
    const normalized = normalizeTimestamp(String(observedAt));
    if (!normalized) {
      return;
    }
    const ms = Date.parse(normalized);
    if (ms > bestMs) {
      bestMs = ms;
      best = normalized;
    }
  });
  return best;
}

type TimeseriesRow = {
  observed_at: string;
  value: number | null;
  status?: string | null;
};

function normalizeTimeseriesRows(
  rows: unknown[],
  includeStatus: boolean,
): TimeseriesRow[] {
  const normalizedRows: TimeseriesRow[] = [];
  for (const row of rows) {
    const observedAt = normalizeTimestamp(String((row as any)?.observed_at ?? ""));
    if (!observedAt) {
      continue;
    }
    const rawValue = (row as any)?.value;
    const parsedValue = rawValue === null || rawValue === undefined
      ? null
      : Number(rawValue);
    const baseRow: TimeseriesRow = {
      observed_at: observedAt,
      value: parsedValue === null || Number.isFinite(parsedValue) ? parsedValue : null,
    };
    if (includeStatus) {
      baseRow.status = (row as any)?.status == null ? null : String((row as any).status);
    }
    normalizedRows.push(baseRow);
  }
  return normalizedRows;
}

function timeseriesColumns(includeStatus: boolean): string[] {
  return includeStatus ? ["observed_at", "value", "status"] : ["observed_at", "value"];
}

function shapeTimeseriesData(
  rows: TimeseriesRow[],
  format: "objects" | "compact",
  includeStatus: boolean,
): unknown[] {
  if (format === "compact") {
    return rows.map((row) =>
      includeStatus
        ? [row.observed_at, row.value, row.status ?? null]
        : [row.observed_at, row.value]
    );
  }
  return rows.map((row) =>
    includeStatus
      ? { observed_at: row.observed_at, value: row.value, status: row.status ?? null }
      : { observed_at: row.observed_at, value: row.value }
  );
}

function etagPayload(payload: {
  timeseries_id: number;
  window: string;
  since: string | null;
  next_since: string | null;
  include_status: boolean;
  data_format: string;
  columns: string[];
  count: number;
  guideline: unknown;
  data: unknown;
}) {
  return {
    timeseries_id: payload.timeseries_id,
    window: payload.window,
    since: payload.since,
    next_since: payload.next_since,
    include_status: payload.include_status,
    data_format: payload.data_format,
    columns: payload.columns,
    count: payload.count,
    guideline: payload.guideline,
    data: payload.data,
  };
}

function json(payload: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...cacheControlHeaders(status, CACHE_CONTROL_SUCCESS_SMAXAGE_300),
      ...extraHeaders,
    },
  });
}

function notModified(etag: string): Response {
  return new Response(null, {
    status: 304,
    headers: {
      ...CORS_HEADERS,
      ...cacheControlHeaders(200, CACHE_CONTROL_SUCCESS_SMAXAGE_300),
      ETag: etag,
    },
  });
}
