//trigger deploy 2026-02-12 17:17
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import "../_shared/fetch_egress_patch.ts";
import {
  CACHE_CONTROL_SUCCESS_SMAXAGE_300,
  cacheControlHeaders,
} from "../_shared/cache.ts";
import { createWeakEtag, ifNoneMatchMatches } from "../_shared/etag.ts";
import { logEndpointEgress } from "../_shared/egress_metrics.ts";
import { validateWorkerUpstreamAuth } from "../_shared/worker_auth.ts";

const DEFAULT_WINDOW = "24h";
const DEFAULT_FORMAT = "objects";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type NamedWindowLabel = "12h" | "24h" | "7d" | "31d" | "90d";
type IngestWindowLabel = "12h" | "24h" | "7d" | "30d";

const WINDOW_HOURS: Record<NamedWindowLabel, number> = {
  "12h": 12,
  "24h": 24,
  "7d": 24 * 7,
  "31d": 24 * 31,
  "90d": 24 * 90,
};
const MAX_WINDOW_DAYS = parsePositiveInteger(
  Deno.env.get("UK_AQ_TIMESERIES_MAX_WINDOW_DAYS"),
) ?? 366;
const RECENT_SOURCE_OF_TRUTH_HOURS = Math.max(
  1,
  Math.min(
    24 * 45,
    parsePositiveInteger(
      Deno.env.get("UK_AQ_TIMESERIES_RECENT_SOURCE_OF_TRUTH_HOURS"),
    ) ?? 24 * 14,
  ),
);
const INGEST_SOURCE_OF_TRUTH_HOURS = Math.max(
  1,
  Math.min(
    RECENT_SOURCE_OF_TRUTH_HOURS,
    parsePositiveInteger(
      Deno.env.get("UK_AQ_TIMESERIES_INGEST_SOURCE_OF_TRUTH_HOURS"),
    ) ?? 24,
  ),
);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ??
  Deno.env.get("SB_SUPABASE_URL") ??
  "";
const SB_SECRET_KEY = Deno.env.get("SB_SECRET_KEY") ?? "";
const SUPABASE_PRIVILEGED_KEY = SB_SECRET_KEY;
const OBS_AQIDB_SUPABASE_URL = (
  Deno.env.get("OBS_AQIDB_SUPABASE_URL") ?? ""
).trim();
const OBS_AQIDB_SECRET_KEY = (Deno.env.get("OBS_AQIDB_SECRET_KEY") ?? "").trim();
const EDGE_UPSTREAM_SECRET = Deno.env.get("UK_AQ_EDGE_UPSTREAM_SECRET") ?? "";
const OBSERVS_HISTORY_R2_API_URL = String(
  Deno.env.get("UK_AQ_OBSERVS_HISTORY_R2_API_URL") ?? "",
).trim();
const OBS_AQIDB_TIMESERIES_WINDOW_RPC = "uk_aq_rpc_observs_timeseries_window";
const OBSERVS_HISTORY_R2_API_TIMEOUT_MS = Math.max(
  2000,
  Math.min(
    30000,
    parsePositiveInteger(
      Deno.env.get("UK_AQ_OBSERVS_HISTORY_R2_API_TIMEOUT_MS"),
    ) ??
      10000,
  ),
);
const OBSERVS_HISTORY_R2_CHUNK_DAYS = Math.max(
  1,
  Math.min(
    31,
    parsePositiveInteger(Deno.env.get("UK_AQ_OBSERVS_HISTORY_R2_CHUNK_DAYS")) ??
      7,
  ),
);
const OBSERVS_HISTORY_R2_CHUNK_MAX_RETRIES = Math.max(
  1,
  Math.min(
    4,
    parsePositiveInteger(
      Deno.env.get("UK_AQ_OBSERVS_HISTORY_R2_CHUNK_MAX_RETRIES"),
    ) ?? 4,
  ),
);
const UK_AQ_CORE_SCHEMA = Deno.env.get("UK_AQ_CORE_SCHEMA") ??
  "uk_aq_core";
const UK_AQ_PUBLIC_SCHEMA = Deno.env.get("UK_AQ_PUBLIC_SCHEMA") ??
  "uk_aq_public";
const OBS_AQIDB_RPC_SCHEMA = Deno.env.get("OBS_AQIDB_RPC_SCHEMA") ??
  "uk_aq_public";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, if-none-match",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers": "ETag",
};

const REST_BASE_URL = SUPABASE_URL
  ? `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1`
  : "";

type PostgrestQueryParams = Record<string, string | string[]>;

type PostgrestRequestConfig = {
  baseUrl?: string;
  apiKey?: string;
  caller?: string;
};

function postgrestHeaders(
  apiKey: string,
  schema = UK_AQ_CORE_SCHEMA,
  caller = "uk_aq_timeseries",
): Record<string, string> {
  const headers: Record<string, string> = {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "x-ukaq-egress-caller": caller,
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
  params?: PostgrestQueryParams,
  schema?: string,
  body?: unknown,
  config?: PostgrestRequestConfig,
): Promise<{ data: T | null; error: { message: string } | null }> {
  const baseUrl = config?.baseUrl ?? REST_BASE_URL;
  const apiKey = config?.apiKey ?? SUPABASE_PRIVILEGED_KEY;
  const caller = config?.caller ?? "uk_aq_timeseries";
  if (!baseUrl || !apiKey) {
    return {
      data: null,
      error: { message: "Missing SUPABASE_URL or SB_SECRET_KEY." },
    };
  }
  const url = new URL(`${baseUrl}/${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) {
      if (Array.isArray(value)) {
        for (const part of value) {
          if (part !== undefined && part !== null) {
            url.searchParams.append(key, String(part));
          }
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  const resp = await fetch(url.toString(), {
    method,
    headers: postgrestHeaders(apiKey, schema, caller),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = resp.headers.get("content-type") ?? "";
  const payload: any = contentType.includes("application/json")
    ? await resp.json()
    : await resp.text();
  if (!resp.ok) {
    const message = payload?.message || payload?.error_description ||
      payload?.error || resp.statusText;
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
      headers: {
        ...CORS_HEADERS,
        ...cacheControlHeaders(405, CACHE_CONTROL_SUCCESS_SMAXAGE_300),
      },
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
    return await finish(
      json({ error: "Missing SUPABASE_URL or SB_SECRET_KEY." }, 500),
      {
        error_type: "missing_env",
      },
    );
  }

  const url = new URL(req.url);
  const timeseriesId = parseId(url.searchParams.get("timeseries_id"));
  if (!timeseriesId) {
    return await finish(
      json({ error: "Missing or invalid timeseries_id." }, 400),
      {
        error_type: "invalid_timeseries_id",
      },
    );
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
    return await finish(
      json({
        error: "Invalid limit. Provide a positive integer or omit limit.",
      }, 400),
      {
        error_type: "invalid_limit",
      },
    );
  }
  const rawSince = url.searchParams.get("since");
  const since = rawSince === null ? null : normalizeTimestamp(rawSince);
  if (rawSince !== null && since === null) {
    return await finish(
      json({
        error:
          "Invalid since timestamp. Provide ISO-8601 datetime (e.g. 2026-02-07T10:30:00Z).",
      }, 400),
      { error_type: "invalid_since" },
    );
  }
  const rawFormat = url.searchParams.get("format");
  const responseFormat = normalizeFormat(rawFormat);
  if (rawFormat !== null && responseFormat === null) {
    return await finish(
      json({ error: "Invalid format. Use 'objects' or 'compact'." }, 400),
      {
        error_type: "invalid_format",
      },
    );
  }
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
    format,
    has_if_none_match: Boolean(ifNoneMatch),
  };

  try {
    const stitched = await fetchTimeseriesRowsStitched({
      timeseriesId,
      limit,
      since,
      requestStart: range.start,
      requestEnd: range.end,
      now,
    });
    const rows = stitched.rows;
    const nextSince = maxObservedTimestamp(rows, since);
    const columns = timeseriesColumns();
    const payload = {
      timeseries_id: timeseriesId,
      window: range.windowLabel,
      window_mode: range.mode,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      since,
      next_since: nextSince,
      data_format: format,
      columns,
      count: rows.length,
      source: stitched.source,
      guideline: stitched.guideline,
      data: shapeTimeseriesData(rows, format),
    };
    const etag = await createWeakEtag({
      endpoint: "uk_aq_timeseries",
      version: 2,
      payload: etagPayload(payload),
    });
    if (ifNoneMatchMatches(ifNoneMatch, etag)) {
      return await finish(notModified(etag), {
        ...requestFields,
        result: "not_modified",
      });
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
  windowLabel: IngestWindowLabel;
  limit: number | null;
  since: string | null;
};

type StitchedFetchOptions = {
  timeseriesId: number;
  limit: number | null;
  since: string | null;
  requestStart: Date;
  requestEnd: Date;
  now: Date;
};

type StitchedFetchResult = {
  guideline: unknown;
  rows: TimeseriesRow[];
  source: "recent_only" | "history_only" | "recent_history_stitched";
};

type TimeseriesConnectorRow = {
  connector_id: unknown;
};

type ObservsHistoryWindowCallOptions = {
  timeseriesId: number;
  connectorId: number;
  startUtc: string;
  endUtc: string;
  since: string | null;
  limit: number | null;
};

type ObservsRecentWindowRow = {
  observed_at: unknown;
  value: unknown;
};

type ObservsHistoryApiPayload = {
  ok?: boolean;
  rows?: unknown[];
  error?: string;
};

type ChunkFetchResult = {
  rows: TimeseriesRow[];
  chunkCount: number;
  failedChunkCount: number;
  lastError: string | null;
};

async function callTimeseriesRpc(
  { timeseriesId, windowLabel, limit, since }: TimeseriesRpcCallOptions,
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
      include_status: false,
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
    requestStart,
    requestEnd,
    now,
  }: StitchedFetchOptions,
): Promise<StitchedFetchResult> {
  const localBoundary = new Date(
    now.getTime() - RECENT_SOURCE_OF_TRUTH_HOURS * HOUR_MS,
  );
  const ingestBoundary = new Date(
    now.getTime() - INGEST_SOURCE_OF_TRUTH_HOURS * HOUR_MS,
  );
  const historyStart = requestStart;
  const historyEnd = requestEnd.getTime() < localBoundary.getTime()
    ? requestEnd
    : localBoundary;
  const obsAqidbStart = requestStart.getTime() > localBoundary.getTime()
    ? requestStart
    : localBoundary;
  const obsAqidbEnd = requestEnd.getTime() < ingestBoundary.getTime()
    ? requestEnd
    : ingestBoundary;
  const ingestStart = requestStart.getTime() > ingestBoundary.getTime()
    ? requestStart
    : ingestBoundary;
  const ingestEnd = requestEnd.getTime() < now.getTime() ? requestEnd : now;
  const hasHistoryWindow = historyEnd.getTime() > historyStart.getTime();
  const hasObsAqidbWindow = obsAqidbEnd.getTime() > obsAqidbStart.getTime();
  const hasIngestWindow = ingestEnd.getTime() > ingestStart.getTime();
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  const hasSince = Number.isFinite(sinceMs);
  const shouldFetchHistory = hasHistoryWindow &&
    (!hasSince || sinceMs < historyEnd.getTime());
  const shouldFetchObsAqidbRows = hasObsAqidbWindow &&
    (!hasSince || sinceMs < obsAqidbEnd.getTime());
  const shouldFetchIngestRows = hasIngestWindow &&
    (!hasSince || sinceMs < ingestEnd.getTime());

  const ingestWindowLabel = shouldFetchIngestRows
    ? selectIngestWindowLabel(ingestStart, now)
    : "12h";
  const ingestLimit = shouldFetchIngestRows
    ? (shouldFetchHistory || shouldFetchObsAqidbRows ? null : limit)
    : 1;
  const ingestSince = shouldFetchIngestRows ? since : null;
  const { data, error } = await callTimeseriesRpc({
    timeseriesId,
    windowLabel: ingestWindowLabel,
    limit: ingestLimit,
    since: ingestSince,
  });
  if (error) {
    throw new Error(error.message);
  }

  const ingestRow = Array.isArray(data) && data.length > 0 ? data[0] : null;
  const guideline = ingestRow?.guideline ?? null;
  const ingestRpcRows = shouldFetchIngestRows
    ? normalizeTimeseriesRows(Array.isArray(ingestRow?.data) ? ingestRow.data : [])
    : [];
  const ingestRows = shouldFetchIngestRows
    ? filterRowsToWindow(
      ingestRpcRows,
      ingestStart,
      ingestEnd,
      since,
    )
    : [];

  let connectorId: number | null = null;
  if (shouldFetchHistory || shouldFetchObsAqidbRows) {
    connectorId = await resolveTimeseriesConnectorId(timeseriesId);
  }

  let obsAqidbRows: TimeseriesRow[] = [];
  if (shouldFetchObsAqidbRows) {
    if (connectorId !== null) {
      try {
        obsAqidbRows = await callObservsRecentWindow({
          timeseriesId,
          connectorId,
          startUtc: obsAqidbStart.toISOString(),
          endUtc: obsAqidbEnd.toISOString(),
          since,
          limit: shouldFetchHistory || shouldFetchIngestRows ? null : limit,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("uk_aq_timeseries obs_aqidb recent fetch fallback", {
          timeseries_id: timeseriesId,
          connector_id: connectorId,
          message,
        });
        try {
          obsAqidbRows = await callIngestFallbackWindow({
            timeseriesId,
            start: obsAqidbStart,
            end: obsAqidbEnd,
            now,
            since,
          });
        } catch (fallbackError) {
          const fallbackMessage = fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError);
          console.warn("uk_aq_timeseries ingest fallback fetch failed", {
            timeseries_id: timeseriesId,
            message: fallbackMessage,
          });
        }
      }
    } else {
      console.warn(
        "uk_aq_timeseries recent obs_aqidb fetch skipped: connector unresolved",
        {
          timeseries_id: timeseriesId,
        },
      );
      try {
        obsAqidbRows = await callIngestFallbackWindow({
          timeseriesId,
          start: obsAqidbStart,
          end: obsAqidbEnd,
          now,
          since,
        });
      } catch (fallbackError) {
        const fallbackMessage = fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
        console.warn("uk_aq_timeseries ingest fallback fetch failed", {
          timeseries_id: timeseriesId,
          message: fallbackMessage,
        });
      }
    }
  }

  let historyRows: TimeseriesRow[] = [];
  let didLoadHistoryRows = false;
  if (shouldFetchHistory) {
    if (connectorId !== null) {
      const historyStartUtc = historyStart.toISOString();
      const historyEndUtc = historyEnd.toISOString();
      try {
        const historyWindow = await callObservsHistoryWindow({
          timeseriesId,
          connectorId,
          startUtc: historyStartUtc,
          endUtc: historyEndUtc,
          since,
          limit,
        });
        historyRows = historyWindow.rows;
        didLoadHistoryRows = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          shouldRetryHistoryChunked(message, historyStartUtc, historyEndUtc)
        ) {
          try {
            const historyWindow = await callObservsHistoryWindowChunked({
              timeseriesId,
              connectorId,
              startUtc: historyStartUtc,
              endUtc: historyEndUtc,
              since,
              limit,
            });
            historyRows = historyWindow.rows;
            didLoadHistoryRows = historyWindow.rows.length > 0 ||
              historyWindow.failedChunkCount === 0;
            console.info(
              "uk_aq_timeseries history fetch recovered via chunked retry",
              {
                timeseries_id: timeseriesId,
                connector_id: connectorId,
                chunk_days: OBSERVS_HISTORY_R2_CHUNK_DAYS,
                chunk_count: historyWindow.chunkCount,
                failed_chunk_count: historyWindow.failedChunkCount,
                first_error: message,
              },
            );
          } catch (chunkedError) {
            const chunkedMessage = chunkedError instanceof Error
              ? chunkedError.message
              : String(chunkedError);
            console.warn("uk_aq_timeseries history fetch fallback", {
              timeseries_id: timeseriesId,
              connector_id: connectorId,
              message,
              chunked_retry_error: chunkedMessage,
              chunk_days: OBSERVS_HISTORY_R2_CHUNK_DAYS,
            });
          }
        } else {
          console.warn("uk_aq_timeseries history fetch fallback", {
            timeseries_id: timeseriesId,
            connector_id: connectorId,
            message,
          });
        }
      }
    } else {
      console.warn(
        "uk_aq_timeseries history fetch skipped: connector unresolved",
        {
          timeseries_id: timeseriesId,
        },
      );
    }
  }

  const source: StitchedFetchResult["source"] =
    didLoadHistoryRows && (shouldFetchObsAqidbRows || shouldFetchIngestRows)
      ? "recent_history_stitched"
      : didLoadHistoryRows
      ? "history_only"
      : "recent_only";

  return {
    guideline,
    rows: finalizeStitchedRows(
      historyRows,
      obsAqidbRows,
      ingestRows,
      since,
      limit,
      requestStart,
      requestEnd,
    ),
    source,
  };
}

function selectIngestWindowLabel(start: Date, now: Date): IngestWindowLabel {
  const spanHours = (now.getTime() - start.getTime()) / HOUR_MS;
  if (spanHours <= 12) {
    return "12h";
  }
  if (spanHours <= 24) {
    return "24h";
  }
  if (spanHours <= 24 * 7) {
    return "7d";
  }
  return "30d";
}

async function resolveTimeseriesConnectorId(
  timeseriesId: number,
): Promise<number | null> {
  const response = await postgrestRequest<TimeseriesConnectorRow[]>(
    "GET",
    "timeseries",
    {
      select: "connector_id",
      id: `eq.${timeseriesId}`,
      limit: "1",
    },
    UK_AQ_CORE_SCHEMA,
    undefined,
    {
      caller: "uk_aq_timeseries_connector_lookup",
    },
  );
  if (response.error) {
    console.warn("uk_aq_timeseries connector lookup failed", {
      timeseries_id: timeseriesId,
      message: response.error.message,
    });
    return null;
  }
  const row = Array.isArray(response.data) && response.data.length > 0
    ? response.data[0]
    : null;
  const connectorId = Number(row?.connector_id);
  if (!Number.isFinite(connectorId) || connectorId <= 0) {
    return null;
  }
  return Math.trunc(connectorId);
}

async function callObservsHistoryWindow(
  {
    timeseriesId,
    connectorId,
    startUtc,
    endUtc,
    since,
    limit,
  }: ObservsHistoryWindowCallOptions,
): Promise<{ rows: TimeseriesRow[] }> {
  if (!OBSERVS_HISTORY_R2_API_URL) {
    throw new Error("Missing UK_AQ_OBSERVS_HISTORY_R2_API_URL.");
  }
  if (!EDGE_UPSTREAM_SECRET) {
    throw new Error("Missing UK_AQ_EDGE_UPSTREAM_SECRET.");
  }

  const endpoint = new URL(OBSERVS_HISTORY_R2_API_URL);
  if (!endpoint.pathname || endpoint.pathname === "/") {
    endpoint.pathname = "/v1/observations";
  }
  endpoint.searchParams.set("timeseries_id", String(timeseriesId));
  endpoint.searchParams.set("connector_id", String(connectorId));
  endpoint.searchParams.set("start_utc", startUtc);
  endpoint.searchParams.set("end_utc", endUtc);
  if (since) {
    endpoint.searchParams.set("since_utc", since);
  }
  if (limit !== null) {
    endpoint.searchParams.set("limit", String(Math.max(1, limit)));
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    OBSERVS_HISTORY_R2_API_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-uk-aq-upstream-auth": EDGE_UPSTREAM_SECRET,
        "x-ukaq-egress-caller": "uk_aq_timeseries_history_r2",
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("observs history R2 request timed out");
    }
    throw new Error(`observs history R2 request failed: ${String(error)}`);
  } finally {
    clearTimeout(timeoutId);
  }

  const payloadText = await response.text();
  let payload: ObservsHistoryApiPayload | null = null;
  try {
    payload = payloadText ? JSON.parse(payloadText) : null;
  } catch (_error) {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.error || payloadText || `HTTP ${response.status}`;
    throw new Error(
      `observs history R2 response failed (${response.status}): ${
        String(message)
      }`,
    );
  }
  if (payload && payload.ok === false) {
    throw new Error(
      `observs history R2 returned error: ${
        String(payload.error || "unknown")
      }`,
    );
  }
  return {
    rows: normalizeTimeseriesRows(
      Array.isArray(payload?.rows) ? payload.rows : [],
    ),
  };
}

async function callIngestFallbackWindow(
  {
    timeseriesId,
    start,
    end,
    now,
    since,
  }: {
    timeseriesId: number;
    start: Date;
    end: Date;
    now: Date;
    since: string | null;
  },
): Promise<TimeseriesRow[]> {
  const { data, error } = await callTimeseriesRpc({
    timeseriesId,
    windowLabel: selectIngestWindowLabel(start, now),
    limit: null,
    since,
  });
  if (error) {
    throw new Error(error.message);
  }
  const ingestRow = Array.isArray(data) && data.length > 0 ? data[0] : null;
  return filterRowsToWindow(
    normalizeTimeseriesRows(Array.isArray(ingestRow?.data) ? ingestRow.data : []),
    start,
    end,
    since,
  );
}

async function callObservsRecentWindow(
  {
    timeseriesId,
    connectorId,
    startUtc,
    endUtc,
    since,
    limit,
  }: ObservsHistoryWindowCallOptions,
): Promise<TimeseriesRow[]> {
  if (!OBS_AQIDB_SUPABASE_URL || !OBS_AQIDB_SECRET_KEY) {
    throw new Error(
      "Missing OBS_AQIDB_SUPABASE_URL or OBS_AQIDB_SECRET_KEY.",
    );
  }

  const obsAqidbRestBaseUrl = `${OBS_AQIDB_SUPABASE_URL.replace(/\/$/, "")}/rest/v1`;
  const response = await postgrestRequest<ObservsRecentWindowRow[]>(
    "POST",
    `rpc/${OBS_AQIDB_TIMESERIES_WINDOW_RPC}`,
    undefined,
    OBS_AQIDB_RPC_SCHEMA,
    {
      p_connector_id: connectorId,
      p_timeseries_id: timeseriesId,
      p_start_utc: startUtc,
      p_end_utc: endUtc,
      p_since_ts: since,
      p_limit: limit,
    },
    {
      baseUrl: obsAqidbRestBaseUrl,
      apiKey: OBS_AQIDB_SECRET_KEY,
      caller: "uk_aq_timeseries_obs_aqidb_recent",
    },
  );
  if (response.error) {
    throw new Error(response.error.message);
  }
  return normalizeTimeseriesRows(Array.isArray(response.data) ? response.data : []);
}

async function callObservsHistoryWindowChunked(
  {
    timeseriesId,
    connectorId,
    startUtc,
    endUtc,
    since,
    limit,
  }: ObservsHistoryWindowCallOptions,
): Promise<
  { rows: TimeseriesRow[]; chunkCount: number; failedChunkCount: number }
> {
  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  if (
    !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs
  ) {
    return { rows: [], chunkCount: 0, failedChunkCount: 0 };
  }

  const chunkMs = OBSERVS_HISTORY_R2_CHUNK_DAYS * DAY_MS;
  const mergedRows: TimeseriesRow[] = [];
  let cursorMs = startMs;
  let chunkCount = 0;
  let failedChunkCount = 0;
  while (cursorMs < endMs) {
    const chunkEndMs = Math.min(endMs, cursorMs + chunkMs);
    const chunkStartUtc = new Date(cursorMs).toISOString();
    const chunkEndUtc = new Date(chunkEndMs).toISOString();
    const chunkResult = await fetchHistoryChunkWithBisectRetry({
      timeseriesId,
      connectorId,
      startUtc: chunkStartUtc,
      endUtc: chunkEndUtc,
      since,
      limit: null,
    });
    chunkCount += chunkResult.chunkCount;
    failedChunkCount += chunkResult.failedChunkCount;
    if (chunkResult.rows.length > 0) {
      mergedRows.push(...chunkResult.rows);
    }
    if (chunkResult.failedChunkCount > 0) {
      console.warn("uk_aq_timeseries history chunk partially skipped", {
        timeseries_id: timeseriesId,
        connector_id: connectorId,
        chunk_start_utc: chunkStartUtc,
        chunk_end_utc: chunkEndUtc,
        failed_chunk_count: chunkResult.failedChunkCount,
        chunk_error: chunkResult.lastError,
        chunk_retry_attempts: OBSERVS_HISTORY_R2_CHUNK_MAX_RETRIES,
      });
    }
    if (limit !== null && mergedRows.length >= limit) {
      return {
        rows: mergedRows.slice(0, limit),
        chunkCount,
        failedChunkCount,
      };
    }
    cursorMs = chunkEndMs;
  }
  return { rows: mergedRows, chunkCount, failedChunkCount };
}

async function fetchHistoryChunkWithBisectRetry(
  {
    timeseriesId,
    connectorId,
    startUtc,
    endUtc,
    since,
  }: ObservsHistoryWindowCallOptions,
): Promise<ChunkFetchResult> {
  let lastError = "";
  for (
    let attempt = 1;
    attempt <= OBSERVS_HISTORY_R2_CHUNK_MAX_RETRIES;
    attempt += 1
  ) {
    try {
      const historyWindow = await callObservsHistoryWindow({
        timeseriesId,
        connectorId,
        startUtc,
        endUtc,
        since,
        limit: null,
      });
      return {
        rows: historyWindow.rows,
        chunkCount: 1,
        failedChunkCount: 0,
        lastError: null,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  const spanMs = endMs - startMs;
  if (!Number.isFinite(spanMs) || spanMs <= DAY_MS) {
    return {
      rows: [],
      chunkCount: 1,
      failedChunkCount: 1,
      lastError: lastError || "history chunk failed",
    };
  }

  const middleMs = startMs + Math.floor(spanMs / 2);
  if (middleMs <= startMs || middleMs >= endMs) {
    return {
      rows: [],
      chunkCount: 1,
      failedChunkCount: 1,
      lastError: lastError || "history chunk failed",
    };
  }
  const left = await fetchHistoryChunkWithBisectRetry({
    timeseriesId,
    connectorId,
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(middleMs).toISOString(),
    since,
    limit: null,
  });
  const right = await fetchHistoryChunkWithBisectRetry({
    timeseriesId,
    connectorId,
    startUtc: new Date(middleMs).toISOString(),
    endUtc: new Date(endMs).toISOString(),
    since,
    limit: null,
  });
  return {
    rows: [...left.rows, ...right.rows],
    chunkCount: left.chunkCount + right.chunkCount,
    failedChunkCount: left.failedChunkCount + right.failedChunkCount,
    lastError: right.lastError || left.lastError ||
      (lastError || "history chunk failed"),
  };
}

function shouldRetryHistoryChunked(
  message: string,
  startUtc: string,
  endUtc: string,
): boolean {
  const spanMs = Date.parse(endUtc) - Date.parse(startUtc);
  if (
    !Number.isFinite(spanMs) ||
    spanMs <= OBSERVS_HISTORY_R2_CHUNK_DAYS * DAY_MS
  ) {
    return false;
  }
  const normalized = String(message || "").toLowerCase();
  return normalized.includes("response failed (5") ||
    normalized.includes("timed out") ||
    normalized.includes("request failed");
}

function finalizeStitchedRows(
  historyRows: TimeseriesRow[],
  obsAqidbRows: TimeseriesRow[],
  ingestRows: TimeseriesRow[],
  since: string | null,
  limit: number | null,
  requestStart: Date,
  requestEnd: Date,
): TimeseriesRow[] {
  return filterRowsToWindow(
    mergeRowsPreferNewestSource(historyRows, obsAqidbRows, ingestRows),
    requestStart,
    requestEnd,
    since,
    limit,
  );
}

function mergeRowsPreferNewestSource(
  historyRows: TimeseriesRow[],
  obsAqidbRows: TimeseriesRow[],
  ingestRows: TimeseriesRow[],
): TimeseriesRow[] {
  const byObservedAt = new Map<string, TimeseriesRow>();
  for (const row of historyRows) {
    byObservedAt.set(row.observed_at, row);
  }
  for (const row of obsAqidbRows) {
    byObservedAt.set(row.observed_at, row);
  }
  // Ingest is freshest source and overwrites overlapping timestamps.
  for (const row of ingestRows) {
    byObservedAt.set(row.observed_at, row);
  }
  return Array.from(byObservedAt.values()).sort((a, b) =>
    Date.parse(a.observed_at) - Date.parse(b.observed_at)
  );
}

function filterRowsToWindow(
  rows: TimeseriesRow[],
  start: Date,
  end: Date,
  since: string | null,
  limit: number | null = null,
): TimeseriesRow[] {
  const startMs = start.getTime();
  const endMs = end.getTime();
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  let filteredRows = rows.filter((row) => {
    const observedMs = Date.parse(row.observed_at);
    if (!Number.isFinite(observedMs)) {
      return false;
    }
    if (observedMs < startMs || observedMs > endMs) {
      return false;
    }
    return !Number.isFinite(sinceMs) || observedMs > sinceMs;
  });

  if (limit !== null && filteredRows.length > limit) {
    filteredRows = filteredRows.slice(0, limit);
  }

  return filteredRows;
}

function looksLikeTimeseriesSignatureMismatch(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return normalized.includes("could not find the function") &&
    normalized.includes("uk_aq_timeseries_rpc");
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
    return {
      ok: false,
      error: "Provide both start and end (or start_utc and end_utc).",
    };
  }

  const modeCount = Number(hasWindow) + Number(hasDays) + Number(hasDateTime);
  if (modeCount > 1) {
    return {
      ok: false,
      error: "Use only one range selector: window, days, or start/end.",
    };
  }

  if (hasWindow) {
    const parsedWindow = parseNamedWindowLabel(windowToken);
    if (!parsedWindow) {
      return {
        ok: false,
        error: "Invalid window. Use 12h, 24h, 7d, 31d, or 90d.",
      };
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
      return {
        ok: false,
        error: `days exceeds maximum supported range (${MAX_WINDOW_DAYS}).`,
      };
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
      return {
        ok: false,
        error: "Invalid start/end. Provide ISO-8601 datetimes.",
      };
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
      return {
        ok: false,
        error: "start must be before the effective end time.",
      };
    }
    const spanDays = (end.getTime() - start.getTime()) / DAY_MS;
    if (spanDays > MAX_WINDOW_DAYS) {
      return {
        ok: false,
        error:
          `Requested span exceeds maximum supported range (${MAX_WINDOW_DAYS} days).`,
      };
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
  if (
    normalized === "compact" || normalized === "array" ||
    normalized === "arrays"
  ) {
    return "compact";
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

function maxObservedTimestamp(
  rows: any[],
  fallback: string | null,
): string | null {
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
};

function normalizeTimeseriesRows(
  rows: unknown[],
): TimeseriesRow[] {
  const normalizedRows: TimeseriesRow[] = [];
  for (const row of rows) {
    const observedAt = normalizeTimestamp(
      String((row as any)?.observed_at ?? ""),
    );
    if (!observedAt) {
      continue;
    }
    const rawValue = (row as any)?.value;
    const parsedValue = rawValue === null || rawValue === undefined
      ? null
      : Number(rawValue);
    const baseRow: TimeseriesRow = {
      observed_at: observedAt,
      value: parsedValue === null || Number.isFinite(parsedValue)
        ? parsedValue
        : null,
    };
    normalizedRows.push(baseRow);
  }
  return normalizedRows;
}

function timeseriesColumns(): string[] {
  return ["observed_at", "value"];
}

function shapeTimeseriesData(
  rows: TimeseriesRow[],
  format: "objects" | "compact",
): unknown[] {
  if (format === "compact") {
    return rows.map((row) => [row.observed_at, row.value]);
  }
  return rows.map((row) => ({
    observed_at: row.observed_at,
    value: row.value,
  }));
}

function etagPayload(payload: {
  timeseries_id: number;
  window: string;
  since: string | null;
  next_since: string | null;
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
    data_format: payload.data_format,
    columns: payload.columns,
    count: payload.count,
    guideline: payload.guideline,
    data: payload.data,
  };
}

function json(
  payload: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
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
