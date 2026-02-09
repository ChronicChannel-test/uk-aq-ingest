const DEFAULT_SAMPLE_RATE = 0.2;
const SAMPLE_RATE_ENV = "UK_AQ_EGRESS_LOG_SAMPLE_RATE";

type MetricFields = Record<string, unknown>;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseSampleRate(raw: string | undefined | null): number {
  if (!raw) {
    return DEFAULT_SAMPLE_RATE;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SAMPLE_RATE;
  }
  return clamp(parsed, 0, 1);
}

function shouldLog(status: number, sampleRate: number): boolean {
  if (status >= 400 || status === 304) {
    return true;
  }
  if (status >= 200 && status < 300) {
    return Math.random() < sampleRate;
  }
  return false;
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

function cleanFields(fields: MetricFields): MetricFields {
  const output: MetricFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

export async function logEndpointEgress(
  req: Request,
  endpoint: string,
  startedAtMs: number,
  response: Response,
  fields: MetricFields = {},
): Promise<Response> {
  const sampleRate = parseSampleRate(Deno.env.get(SAMPLE_RATE_ENV));
  const status = response.status;
  if (!shouldLog(status, sampleRate)) {
    return response;
  }
  const durationMs = Date.now() - startedAtMs;
  const bytes = await responseBytes(response);
  const payload = {
    metric: "uk_aq_endpoint_egress",
    endpoint,
    method: req.method,
    status,
    duration_ms: durationMs,
    response_bytes: bytes,
    sample_rate: sampleRate,
    ts: new Date().toISOString(),
    ...cleanFields(fields),
  };
  console.log(JSON.stringify(payload));
  return response;
}
