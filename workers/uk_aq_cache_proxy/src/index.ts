export interface Env {
  SUPABASE_URL: unknown;
  SB_PUBLISHABLE_DEFAULT_KEY: unknown;
}

type CacheProfileName = "realtime" | "metadata";

type CacheProfile = {
  edgeTtlSeconds: number;
  browserTtlSeconds: number;
  staleWhileRevalidateSeconds: number;
};

const CACHE_PROFILES: Record<CacheProfileName, CacheProfile> = {
  realtime: {
    edgeTtlSeconds: 60,
    browserTtlSeconds: 30,
    staleWhileRevalidateSeconds: 30,
  },
  metadata: {
    edgeTtlSeconds: 21600,
    browserTtlSeconds: 3600,
    staleWhileRevalidateSeconds: 86400,
  },
};

const FUNCTION_PROFILE_MAP: Record<string, CacheProfileName> = {
  uk_aq_latest: "realtime",
  uk_aq_timeseries: "realtime",
  uk_aq_stations_chart: "realtime",
  uk_aq_stations: "metadata",
  uk_aq_la_hex: "metadata",
  uk_aq_pcon_hex: "metadata",
};

const ROUTE_TO_FUNCTION_MAP: Record<string, keyof typeof FUNCTION_PROFILE_MAP> = {
  latest: "uk_aq_latest",
  timeseries: "uk_aq_timeseries",
  "stations-chart": "uk_aq_stations_chart",
  stations: "uk_aq_stations",
  "la-hex": "uk_aq_la_hex",
  "pcon-hex": "uk_aq_pcon_hex",
};

const API_PREFIX = "/api/aq/";
const CACHE_BYPASS_QUERY = "cache";
const CACHE_BYPASS_VALUE = "bypass";

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}

async function readSecret(value: unknown): Promise<string> {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as { get?: () => Promise<string>; then?: (cb: (v: unknown) => void) => void };
    if (typeof record.get === "function") {
      const resolved = await record.get();
      return typeof resolved === "string" ? resolved : String(resolved ?? "");
    }
    if (typeof record.then === "function") {
      const resolved = await (value as Promise<unknown>);
      return typeof resolved === "string" ? resolved : String(resolved ?? "");
    }
  }
  return value ? String(value) : "";
}

function addCorsHeaders(headers: Headers): void {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type,If-None-Match,If-Modified-Since");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Access-Control-Expose-Headers", "CF-Cache-Status,ETag,X-UK-AQ-Cache,X-UK-AQ-Cache-Profile");
}

function buildCacheControl(profile: CacheProfile): string {
  return [
    "public",
    `max-age=${profile.browserTtlSeconds}`,
    `s-maxage=${profile.edgeTtlSeconds}`,
    `stale-while-revalidate=${profile.staleWhileRevalidateSeconds}`,
  ].join(", ");
}

function normalizeEtag(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed;
}

function matchesIfNoneMatch(ifNoneMatch: string | null, etag: string | null): boolean {
  if (!ifNoneMatch || !etag) {
    return false;
  }
  const normalizedEtag = normalizeEtag(etag);
  const matchers = ifNoneMatch.split(",").map((part) => part.trim()).filter(Boolean);
  if (matchers.includes("*")) {
    return true;
  }
  return matchers.some((candidate) => normalizeEtag(candidate) === normalizedEtag);
}

function shouldCacheRequest(request: Request, url: URL): boolean {
  if (request.method !== "GET") {
    return false;
  }
  const cacheControl = (request.headers.get("Cache-Control") ?? "").toLowerCase();
  if (cacheControl.includes("no-store") || cacheControl.includes("no-cache")) {
    return false;
  }
  const pragma = (request.headers.get("Pragma") ?? "").toLowerCase();
  if (pragma.includes("no-cache")) {
    return false;
  }
  return url.searchParams.get(CACHE_BYPASS_QUERY) !== CACHE_BYPASS_VALUE;
}

function isCacheableUpstreamResponse(response: Response): boolean {
  if (response.status !== 200) {
    return false;
  }
  const cacheControl = (response.headers.get("Cache-Control") ?? "").toLowerCase();
  return !(cacheControl.includes("no-store") || cacheControl.includes("private"));
}

function resolveUpstreamFunction(pathname: string): string | null {
  if (!pathname.startsWith(API_PREFIX)) {
    return null;
  }
  const routeKey = pathname
    .slice(API_PREFIX.length)
    .replace(/\/+$/, "")
    .trim();
  if (!routeKey || routeKey.includes("/")) {
    return null;
  }

  const mapped = ROUTE_TO_FUNCTION_MAP[routeKey];
  if (mapped) {
    return mapped;
  }
  return FUNCTION_PROFILE_MAP[routeKey] ? routeKey : null;
}

function makeErrorResponse(status: number, message: string): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  addCorsHeaders(headers);
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

function makeOptionsResponse(): Response {
  const headers = new Headers();
  addCorsHeaders(headers);
  return new Response(null, { status: 204, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return makeOptionsResponse();
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return makeErrorResponse(405, "method_not_allowed");
    }

    const upstreamFunction = resolveUpstreamFunction(url.pathname);
    if (!upstreamFunction) {
      return makeErrorResponse(404, "route_not_found");
    }

    const profileName = FUNCTION_PROFILE_MAP[upstreamFunction];
    const profile = CACHE_PROFILES[profileName];

    const supabaseUrl = await readSecret(env.SUPABASE_URL);
    const supabasePublishableKey = await readSecret(env.SB_PUBLISHABLE_DEFAULT_KEY);
    if (!supabaseUrl || !supabasePublishableKey) {
      return makeErrorResponse(500, "missing_worker_secrets");
    }

    const shouldUseCache = shouldCacheRequest(request, url);
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });

    if (shouldUseCache && request.method === "GET") {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        if (matchesIfNoneMatch(request.headers.get("If-None-Match"), cachedResponse.headers.get("ETag"))) {
          const notModifiedHeaders = new Headers();
          const etag = cachedResponse.headers.get("ETag");
          const cacheControl = cachedResponse.headers.get("Cache-Control");
          if (etag) {
            notModifiedHeaders.set("ETag", etag);
          }
          if (cacheControl) {
            notModifiedHeaders.set("Cache-Control", cacheControl);
          }
          notModifiedHeaders.set("X-UK-AQ-Cache", "HIT");
          notModifiedHeaders.set("X-UK-AQ-Cache-Profile", profileName);
          addCorsHeaders(notModifiedHeaders);
          return new Response(null, { status: 304, headers: notModifiedHeaders });
        }

        const hitHeaders = new Headers(cachedResponse.headers);
        hitHeaders.set("X-UK-AQ-Cache", "HIT");
        hitHeaders.set("X-UK-AQ-Cache-Profile", profileName);
        addCorsHeaders(hitHeaders);
        return new Response(cachedResponse.body, {
          status: cachedResponse.status,
          statusText: cachedResponse.statusText,
          headers: hitHeaders,
        });
      }
    }

    const upstreamUrl = new URL(`${normalizeBaseUrl(supabaseUrl)}/functions/v1/${upstreamFunction}`);
    upstreamUrl.search = url.search;

    const upstreamHeaders = new Headers();
    upstreamHeaders.set("apikey", supabasePublishableKey);
    upstreamHeaders.set("Authorization", `Bearer ${supabasePublishableKey}`);
    const accept = request.headers.get("Accept");
    if (accept) {
      upstreamHeaders.set("Accept", accept);
    }
    const ifNoneMatch = request.headers.get("If-None-Match");
    if (ifNoneMatch) {
      upstreamHeaders.set("If-None-Match", ifNoneMatch);
    }
    const ifModifiedSince = request.headers.get("If-Modified-Since");
    if (ifModifiedSince) {
      upstreamHeaders.set("If-Modified-Since", ifModifiedSince);
    }

    const upstreamResponse = await fetch(upstreamUrl.toString(), {
      method: request.method,
      headers: upstreamHeaders,
    });

    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.delete("Set-Cookie");
    responseHeaders.set("X-UK-AQ-Cache", shouldUseCache ? "MISS" : "BYPASS");
    responseHeaders.set("X-UK-AQ-Cache-Profile", profileName);
    if (upstreamResponse.status === 200) {
      responseHeaders.set("Cache-Control", buildCacheControl(profile));
    }
    addCorsHeaders(responseHeaders);

    const response = new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });

    if (shouldUseCache && request.method === "GET" && isCacheableUpstreamResponse(upstreamResponse)) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  },
};
