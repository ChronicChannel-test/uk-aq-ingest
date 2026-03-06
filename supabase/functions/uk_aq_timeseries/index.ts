//trigger deploy 2026-02-09 13:34
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import "../_shared/fetch_egress_patch.ts";
import { cacheControlHeaders, CACHE_CONTROL_SUCCESS_SMAXAGE_300 } from "../_shared/cache.ts";
import { createWeakEtag, ifNoneMatchMatches } from "../_shared/etag.ts";
import { logEndpointEgress } from "../_shared/egress_metrics.ts";
import { validateWorkerUpstreamAuth } from "../_shared/worker_auth.ts";

const DEFAULT_WINDOW = "24h";
const DEFAULT_FORMAT = "objects";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type NamedWindowLabel = "12h" | "24h" | "7d" | "31d";

const WINDOW_HOURS: Record<NamedWindowLabel, number> = {
  "12h": 12,
  "24h": 24,
  "7d": 24 * 7,
  "31d": 24 * 31,
};
const MAX_WINDOW_DAYS = parsePositiveInteger(
  Deno.env.get("UK_AQ_TIMESERIES_MAX_WINDOW_DAYS"),
) ?? 366;
const INGEST_SOURCE_OF_TRUTH_HOURS = 24 * 7;

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
  const auth = validateWorkerUpstreamAuth(req);
  if (!auth.ok) {
    return await finish(json({ error: auth.error }, auth.status), {
      error_type: "upstream_auth",
      auth_status: auth.status,
    });
  }
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
  const rawWindow = url.searchParams.get("window");
  const rawDays = url.searchParams.get("days");
  const rawStart = firstNonEmptyParam(
    url.searchParams.get("start"),
    url.searchParams.get("start_utc"),
  );
  const rawEnd = firstNonEmptyParam(
    url.searchParams.get("end"),
    url.searchParams.get("end_utc"),
  );
  const now = new Date();
  const rangeResult = resolveRequestedRange({
    rawWindow,
    rawDays,
    rawStart,
    rawEnd,
    now,
  });
  if (!rangeResult.ok) {
    return await finish(json({ error: rangeResult.error }, 400), {
      error_type: "invalid_window_range",
    });
  }
  const range = rangeResult.range;
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
  const ifNoneMatch = req.headers.get("if-none-match");
  const requestFields = {
    timeseries_id: timeseriesId,
    window: range.windowLabel,
    window_mode: range.mode,
    days: range.days ?? null,
    has_start_end: range.mode === "datetime",
    limit: limit ?? null,
    has_since: Boolean(since),
    include_status: includeStatus,
    format,
    has_if_none_match: Boolean(ifNoneMatch),
  };

  try {
    const stitched = await fetchTimeseriesRowsStitched({
      timeseriesId,
      limit,
      since,
      includeStatus,
      requestStart: range.start,
      requestEnd: range.end,
      now,
    });
    const rows = stitched.rows;
    const nextSince = maxObservedTimestamp(rows, since);
    const columns = timeseriesColumns(includeStatus);
    const payload = {
      timeseries_id: timeseriesId,
      window: range.windowLabel,
      window_mode: range.mode,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      since,
      next_since: nextSince,
      include_status: includeStatus,
      data_format: format,
      columns,
      count: rows.length,
      guideline: stitched.guideline,
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
      source: stitched.source,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("uk_aq_timeseries runtime failure", { message });
    return await finish(json({ error: "Internal server error." }, 500), {
      ...requestFields,
      error_type: "runtime",
    });
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
  windowLabel: NamedWindowLabel;
  limit: number | null;
  since: string | null;
  includeStatus: boolean;
};

type StitchedFetchOptions = {
  timeseriesId: number;
  limit: number | null;
  since: string | null;
  includeStatus: boolean;
  requestStart: Date;
  requestEnd: Date;
  now: Date;
};

type StitchedFetchResult = {
  guideline: unknown;
  rows: TimeseriesRow[];
  source: "ingest_only" | "history_only" | "ingest_history_stitched";
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

async function fetchTimeseriesRowsStitched(
  {
    timeseriesId,
    limit,
    since,
    includeStatus,
    requestStart,
    requestEnd,
    now,
  }: StitchedFetchOptions,
): Promise<StitchedFetchResult> {
  const splitBoundary = new Date(
    now.getTime() - INGEST_SOURCE_OF_TRUTH_HOURS * HOUR_MS,
  );
  const historyStart = requestStart;
  const historyEnd = requestEnd.getTime() < splitBoundary.getTime()
    ? requestEnd
    : splitBoundary;
  const ingestStart = requestStart.getTime() > splitBoundary.getTime()
    ? requestStart
    : splitBoundary;
  const ingestEnd = requestEnd.getTime() < now.getTime() ? requestEnd : now;
  const hasHistoryWindow = historyEnd.getTime() > historyStart.getTime();
  const hasIngestWindow = ingestEnd.getTime() > ingestStart.getTime();
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  const hasSince = Number.isFinite(sinceMs);
  const shouldFetchHistory = hasHistoryWindow &&
    (!hasSince || sinceMs < historyEnd.getTime());
  const shouldFetchIngestRows = hasIngestWindow &&
    (!hasSince || sinceMs < ingestEnd.getTime());

  const ingestWindowLabel = hasIngestWindow
    ? selectIngestWindowLabel(ingestStart, now)
    : "12h";
  const ingestLimit = shouldFetchIngestRows
    ? (hasHistoryWindow ? null : limit)
    : 1;
  const ingestSince = shouldFetchIngestRows ? since : null;
  const { data, error } = await callTimeseriesRpc({
    timeseriesId,
    windowLabel: ingestWindowLabel,
    limit: ingestLimit,
    since: ingestSince,
    includeStatus,
  });
  if (error) {
    throw new Error(error.message);
  }

  const ingestRow = Array.isArray(data) && data.length > 0 ? data[0] : null;
  const guideline = ingestRow?.guideline ?? null;
  const ingestRows = shouldFetchIngestRows
    ? normalizeTimeseriesRows(
      Array.isArray(ingestRow?.data) ? ingestRow.data : [],
      includeStatus,
    )
    : [];

  let historyRows: TimeseriesRow[] = [];
  if (shouldFetchHistory) {
    const historyWindow = await callHistoryObservationsWindow({
      timeseriesId,
      startUtc: historyStart.toISOString(),
      endUtc: historyEnd.toISOString(),
      includeStatus,
    });
    historyRows = historyWindow.rows;
  }

  const source: StitchedFetchResult["source"] = shouldFetchHistory && shouldFetchIngestRows
    ? "ingest_history_stitched"
    : shouldFetchHistory
    ? "history_only"
    : "ingest_only";

  return {
    guideline,
    rows: finalizeStitchedRows(
      historyRows,
      ingestRows,
      since,
      limit,
      requestStart,
      requestEnd,
    ),
    source,
  };
}

function selectIngestWindowLabel(start: Date, now: Date): NamedWindowLabel {
  const spanHours = (now.getTime() - start.getTime()) / HOUR_MS;
  if (spanHours <= 12) {
    return "12h";
  }
  if (spanHours <= 24) {
    return "24h";
  }
  return "7d";
}

type HistoryWindowCallOptions = {
  timeseriesId: number;
  startUtc: string;
  endUtc: string;
  includeStatus: boolean;
};

async function callHistoryObservationsWindow(
  { timeseriesId, startUtc, endUtc, includeStatus }: HistoryWindowCallOptions,
): Promise<{ rows: TimeseriesRow[] }> {
  const historyWindow = await postgrestRequest<any[]>(
    "POST",
    "rpc/rpc_observations_window",
    undefined,
    UK_AQ_PUBLIC_SCHEMA,
    {
      start_utc: startUtc,
      end_utc: endUtc,
      timeseries_id: timeseriesId,
      station_id: null,
    },
  );
  if (historyWindow.error) {
    if (looksLikeHistoryWindowUnavailable(historyWindow.error.message)) {
      // Keep endpoint available even if the optional history bridge RPC is unavailable.
      return { rows: [] };
    }
    throw new Error(`history window fetch failed: ${historyWindow.error.message}`);
  }
  const rows = normalizeTimeseriesRows(
    Array.isArray(historyWindow.data) ? historyWindow.data : [],
    includeStatus,
  );
  return { rows };
}

function finalizeStitchedRows(
  historyRows: TimeseriesRow[],
  ingestRows: TimeseriesRow[],
  since: string | null,
  limit: number | null,
  requestStart: Date,
  requestEnd: Date,
): TimeseriesRow[] {
  let rows = mergeRowsPreferIngest(historyRows, ingestRows);
  const startMs = requestStart.getTime();
  const endMs = requestEnd.getTime();

  rows = rows.filter((row) => {
    const observedMs = Date.parse(row.observed_at);
    return Number.isFinite(observedMs) && observedMs >= startMs && observedMs <= endMs;
  });

  if (since) {
    const sinceMs = Date.parse(since);
    if (Number.isFinite(sinceMs)) {
      rows = rows.filter((row) => Date.parse(row.observed_at) > sinceMs);
    }
  }

  if (limit !== null && rows.length > limit) {
    rows = rows.slice(0, limit);
  }

  return rows;
}

function mergeRowsPreferIngest(
  historyRows: TimeseriesRow[],
  ingestRows: TimeseriesRow[],
): TimeseriesRow[] {
  const byObservedAt = new Map<string, TimeseriesRow>();
  for (const row of historyRows) {
    byObservedAt.set(row.observed_at, row);
  }
  // Ingest is source of truth and overwrites overlapping timestamps.
  for (const row of ingestRows) {
    byObservedAt.set(row.observed_at, row);
  }
  return Array.from(byObservedAt.values()).sort((a, b) =>
    Date.parse(a.observed_at) - Date.parse(b.observed_at)
  );
}

function looksLikeTimeseriesSignatureMismatch(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return normalized.includes("could not find the function") &&
    normalized.includes("uk_aq_timeseries_rpc");
}

function looksLikeHistoryWindowUnavailable(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("could not find the function") &&
      normalized.includes("rpc_observations_window")
  ) ||
    normalized.includes("relation \"uk_aq_history.observations\" does not exist");
}

type WindowMode = "window" | "days" | "datetime";

type ResolvedWindowRange = {
  mode: WindowMode;
  windowLabel: string;
  start: Date;
  end: Date;
  days: number | null;
};

type ResolveRequestedRangeInput = {
  rawWindow: string | null;
  rawDays: string | null;
  rawStart: string | null;
  rawEnd: string | null;
  now: Date;
};

type ResolveRequestedRangeResult =
  | { ok: true; range: ResolvedWindowRange }
  | { ok: false; error: string };

function resolveRequestedRange(
  { rawWindow, rawDays, rawStart, rawEnd, now }: ResolveRequestedRangeInput,
): ResolveRequestedRangeResult {
  const windowToken = normalizeOptionalParam(rawWindow);
  const daysToken = normalizeOptionalParam(rawDays);
  const startToken = normalizeOptionalParam(rawStart);
  const endToken = normalizeOptionalParam(rawEnd);

  const hasWindow = windowToken !== null;
  const hasDays = daysToken !== null;
  const hasDateTime = startToken !== null || endToken !== null;

  if (hasDateTime && (startToken === null || endToken === null)) {
    return { ok: false, error: "Provide both start and end (or start_utc and end_utc)." };
  }

  const modeCount = Number(hasWindow) + Number(hasDays) + Number(hasDateTime);
  if (modeCount > 1) {
    return { ok: false, error: "Use only one range selector: window, days, or start/end." };
  }

  if (hasWindow) {
    const parsedWindow = parseNamedWindowLabel(windowToken);
    if (!parsedWindow) {
      return { ok: false, error: "Invalid window. Use 12h, 24h, 7d, or 31d." };
    }
    const hours = WINDOW_HOURS[parsedWindow];
    return {
      ok: true,
      range: {
        mode: "window",
        windowLabel: parsedWindow,
        start: new Date(now.getTime() - hours * HOUR_MS),
        end: new Date(now.getTime()),
        days: null,
      },
    };
  }

  if (hasDays) {
    const parsedDays = parsePositiveInteger(daysToken);
    if (parsedDays === null) {
      return { ok: false, error: "Invalid days. Provide a positive integer." };
    }
    if (parsedDays > MAX_WINDOW_DAYS) {
      return { ok: false, error: `days exceeds maximum supported range (${MAX_WINDOW_DAYS}).` };
    }
    return {
      ok: true,
      range: {
        mode: "days",
        windowLabel: `${parsedDays}d`,
        start: new Date(now.getTime() - parsedDays * DAY_MS),
        end: new Date(now.getTime()),
        days: parsedDays,
      },
    };
  }

  if (hasDateTime) {
    const startIso = normalizeTimestamp(startToken as string);
    const endIso = normalizeTimestamp(endToken as string);
    if (!startIso || !endIso) {
      return { ok: false, error: "Invalid start/end. Provide ISO-8601 datetimes." };
    }
    const start = new Date(startIso);
    const requestedEnd = new Date(endIso);
    if (requestedEnd.getTime() <= start.getTime()) {
      return { ok: false, error: "end must be greater than start." };
    }
    const end = requestedEnd.getTime() > now.getTime()
      ? new Date(now.getTime())
      : requestedEnd;
    if (end.getTime() <= start.getTime()) {
      return { ok: false, error: "start must be before the effective end time." };
    }
    const spanDays = (end.getTime() - start.getTime()) / DAY_MS;
    if (spanDays > MAX_WINDOW_DAYS) {
      return { ok: false, error: `Requested span exceeds maximum supported range (${MAX_WINDOW_DAYS} days).` };
    }
    return {
      ok: true,
      range: {
        mode: "datetime",
        windowLabel: "custom",
        start,
        end,
        days: null,
      },
    };
  }

  const defaultWindow = DEFAULT_WINDOW as NamedWindowLabel;
  return {
    ok: true,
    range: {
      mode: "window",
      windowLabel: defaultWindow,
      start: new Date(now.getTime() - WINDOW_HOURS[defaultWindow] * HOUR_MS),
      end: new Date(now.getTime()),
      days: null,
    },
  };
}

function parseNamedWindowLabel(value: string): NamedWindowLabel | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return Object.prototype.hasOwnProperty.call(WINDOW_HOURS, normalized)
    ? normalized as NamedWindowLabel
    : null;
}

function normalizeOptionalParam(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function firstNonEmptyParam(...values: Array<string | null>): string | null {
  for (const value of values) {
    if (value !== null && value.trim()) {
      return value;
    }
  }
  return null;
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
  return parsePositiveInteger(value);
}

function parsePositiveInteger(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
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
