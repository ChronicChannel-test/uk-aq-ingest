import {
  EGRESS_BYPASS_HEADER,
  type MetricFields,
  recordEgressMetric,
} from "./egress_metrics.ts";

const PATCH_FLAG = "__uk_aq_postgrest_egress_patch__";
const ENABLED_ENV = "UK_AQ_POSTGREST_EGRESS_CAPTURE_ENABLED";
const SAMPLE_RATE_ENV = "UK_AQ_POSTGREST_EGRESS_CAPTURE_SAMPLE_RATE";
const DEFAULT_SAMPLE_RATE = 1;
const METRIC_RPC_PATHS = new Set([
  "/rest/v1/rpc/uk_aq_record_endpoint_metric",
  "/rest/v1/rpc/uk_aq_cleanup_endpoint_metrics",
]);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ??
  Deno.env.get("SB_SUPABASE_URL") ??
  "";

function parseBoolean(
  raw: string | undefined | null,
  fallback: boolean,
): boolean {
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseSampleRate(
  raw: string | undefined | null,
  fallback: number,
): number {
  const parsed = Number(raw ?? "");
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return clamp(parsed, 0, 1);
}

function parseUrl(input: Request | URL | string): URL | null {
  try {
    if (input instanceof URL) {
      return input;
    }
    if (typeof input === "string") {
      return new URL(input);
    }
    return new URL(input.url);
  } catch {
    return null;
  }
}

function normalizeMethod(
  input: Request | URL | string,
  init?: RequestInit,
): string {
  if (init?.method) {
    return String(init.method).toUpperCase();
  }
  if (input instanceof Request) {
    return input.method.toUpperCase();
  }
  return "GET";
}

function readHeader(
  input: Request | URL | string,
  init: RequestInit | undefined,
  name: string,
): string {
  const target = name.toLowerCase();
  const initHeaders = new Headers(init?.headers ?? undefined);
  const initValue = initHeaders.get(target);
  if (initValue) {
    return initValue;
  }
  if (input instanceof Request) {
    return input.headers.get(target) ?? "";
  }
  return "";
}

function endpointForUrl(url: URL): string | null {
  if (!SUPABASE_URL) {
    return null;
  }
  let supabaseOrigin: string;
  try {
    supabaseOrigin = new URL(SUPABASE_URL).origin;
  } catch {
    return null;
  }
  if (url.origin !== supabaseOrigin) {
    return null;
  }
  if (!url.pathname.startsWith("/rest/v1/")) {
    return null;
  }
  if (METRIC_RPC_PATHS.has(url.pathname)) {
    return null;
  }
  const trimmed = url.pathname.replace(/^\/rest\/v1\/?/, "");
  return `postgrest:${trimmed || "root"}`;
}

async function responseBytes(response: Response): Promise<number | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  if (!response.body) {
    return 0;
  }
  try {
    const bytes = await response.clone().arrayBuffer();
    return bytes.byteLength;
  } catch {
    return null;
  }
}

function extractMeta(url: URL, method: string): MetricFields {
  const pathname = url.pathname.replace(/^\/rest\/v1\//, "");
  const select = url.searchParams.get("select");
  return {
    target: pathname || null,
    has_select: Boolean(select),
    query_params: Array.from(url.searchParams.keys()).slice(0, 12),
    method,
  };
}

function shouldSkipBypassHeader(
  input: Request | URL | string,
  init?: RequestInit,
): boolean {
  return readHeader(input, init, EGRESS_BYPASS_HEADER) === "1";
}

function applyPatch(): void {
  const globalRef = globalThis as Record<string, unknown>;
  if (globalRef[PATCH_FLAG]) {
    return;
  }
  if (!parseBoolean(Deno.env.get(ENABLED_ENV), true)) {
    globalRef[PATCH_FLAG] = true;
    return;
  }
  const sampleRate = parseSampleRate(
    Deno.env.get(SAMPLE_RATE_ENV),
    DEFAULT_SAMPLE_RATE,
  );
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (
    input: Request | URL | string,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = parseUrl(input);
    const endpoint = url ? endpointForUrl(url) : null;
    const track = Boolean(endpoint) && !shouldSkipBypassHeader(input, init);
    const method = normalizeMethod(input, init);
    const startedAt = track ? Date.now() : 0;
    const response = await nativeFetch(input as RequestInfo | URL, init);
    if (!track || !endpoint || !url) {
      return response;
    }
    const durationMs = Date.now() - startedAt;
    const bytes = await responseBytes(response);
    try {
      await recordEgressMetric({
        endpoint,
        method,
        status: response.status,
        durationMs,
        responseBytes: bytes,
        fields: extractMeta(url, method),
        sampleRate,
        force: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({
        metric: "uk_aq_postgrest_egress_capture_warning",
        message,
        endpoint,
        ts: new Date().toISOString(),
      }));
    }
    return response;
  };
  globalRef[PATCH_FLAG] = true;
}

applyPatch();
