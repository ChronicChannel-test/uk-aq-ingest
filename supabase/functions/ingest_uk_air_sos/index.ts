import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type PollRequest = {
  service_id?: string;
  service_label?: string;
  window_hours?: number;
  pollutants?: string[] | string;
  timeseries_ids?: string[] | string;
  timeseries_limit?: number;
};

type ServiceRow = {
  id: string;
  label: string;
  service_url: string | null;
  poll_enabled: boolean | null;
  poll_window_hours: number | null;
  poll_timeseries_batch_size: number | null;
};

const DEFAULT_BASE_URL = "https://uk-air.defra.gov.uk/sos-ukair/api/v1";
const DEFAULT_SERVICE_LABEL = "UK-AIR-SOS";
const DEFAULT_WINDOW_HOURS = 6;
const DEFAULT_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 1000;
const CONCURRENCY_LIMIT = 5;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const UK_AIR_SOS_BASE_URL = (Deno.env.get("UK_AIR_SOS_BASE_URL")
  ?? Deno.env.get("UK_AIR_BASE_URL")
  ?? DEFAULT_BASE_URL).replace(/\/$/, "");
const UK_AIR_SOS_SERVICE_LABEL = Deno.env.get("UK_AIR_SOS_SERVICE_LABEL")
  ?? Deno.env.get("UK_AIR_SERVICE_LABEL")
  ?? DEFAULT_SERVICE_LABEL;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." }, 500);
  }

  const payload = await readJson(req);
  const serviceId = asString(payload?.service_id);
  const serviceLabel = asString(payload?.service_label) || UK_AIR_SOS_SERVICE_LABEL;
  const windowHours = asNumber(payload?.window_hours, undefined);
  const pollutants = parseList(payload?.pollutants);
  const limit = asNumber(payload?.timeseries_limit, undefined);
  const requestedSeries = parseList(payload?.timeseries_ids);

  const service = await loadService(serviceId, serviceLabel);
  if (!service) {
    return json({ error: "Service not found and could not be discovered." }, 404);
  }
  if (service.poll_enabled === false) {
    return json({ status: "poll_disabled", service_id: service.id }, 200);
  }

  const pollWindow = windowHours ?? service.poll_window_hours ?? DEFAULT_WINDOW_HOURS;
  const effectiveLimit = limit ?? service.poll_timeseries_batch_size ?? undefined;
  const baseUrl = (service.service_url || UK_AIR_SOS_BASE_URL).replace(/\/$/, "");

  let series = await loadTimeseries(service.id);
  if (requestedSeries?.length) {
    const requestedSet = new Set(requestedSeries.map((value) => value.toLowerCase()));
    series = series.filter((row) => {
      const idMatch = row.id && requestedSet.has(String(row.id).toLowerCase());
      const sourceMatch = row.source_id
        && requestedSet.has(String(row.source_id).toLowerCase());
      return idMatch || sourceMatch;
    });
  }

  if (pollutants?.length) {
    const allowedPhenomena = await loadPhenomena(service.id, pollutants);
    if (allowedPhenomena.size === 0) {
      return json({ status: "no_matching_pollutants", service_id: service.id }, 200);
    }
    series = series.filter((row) => row.phenomenon_id && allowedPhenomena.has(row.phenomenon_id));
  }

  if (typeof effectiveLimit === "number" && effectiveLimit > 0) {
    series = series.slice(0, effectiveLimit);
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() - pollWindow * 60 * 60 * 1000);
  const timespan = `${windowStart.toISOString()}/${now.toISOString()}`;

  let polled = 0;
  let observationsUpserted = 0;
  const errors: string[] = [];

  await runPool(series, CONCURRENCY_LIMIT, async (row) => {
    try {
      const sourceId = row.source_id || String(row.id);
      const data = await fetchJson(
        baseUrl,
        `/timeseries/${encodeURIComponent(sourceId)}/getData`,
        { timespan, format: "tvp" },
      );
      const points = parseDatapoints(data?.values);
      if (points.length) {
        const { error } = await supabase
          .from("observations")
          .upsert(points.map((point) => ({
            timeseries_id: row.id,
            observed_at: point.observed_at,
            value: point.value,
            status: point.status,
          })), { onConflict: "timeseries_id,observed_at" });
        if (error) {
          throw new Error(`observations upsert failed for ${row.id}: ${error.message}`);
        }
        observationsUpserted += points.length;
      }
      await upsertLastValue(row.id, data, points);
      polled += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${row.id}: ${message}`);
      console.warn(`Poll failed for ${row.id}: ${message}`);
    }
  });

  const { error: pollUpdateError } = await supabase
    .from("services")
    .update({ last_polled_at: now.toISOString() })
    .eq("id", service.id);
  if (pollUpdateError) {
    errors.push(`service last_polled_at update failed: ${pollUpdateError.message}`);
  }

  return json({
    status: "ok",
    service_id: service.id,
    series_polled: polled,
    observations_upserted: observationsUpserted,
    errors,
  }, errors.length ? 207 : 200);
});

async function readJson(req: Request): Promise<PollRequest | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function asNumber(value: unknown, fallback: number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function parseList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    const parts = value.split(",").map((item) => item.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  }
  return undefined;
}

function normalizeServiceLabel(label: string | undefined): string {
  if (!label) {
    return UK_AIR_SOS_SERVICE_LABEL;
  }
  const trimmed = label.trim();
  if (!trimmed) {
    return UK_AIR_SOS_SERVICE_LABEL;
  }
  if (trimmed.toLowerCase().startsWith("my timeseries service")) {
    return UK_AIR_SOS_SERVICE_LABEL;
  }
  return trimmed;
}

async function loadService(
  serviceId: string | undefined,
  serviceLabel: string,
): Promise<ServiceRow | null> {
  if (serviceId) {
    const { data } = await supabase
      .from("services")
      .select("id,label,service_url,poll_enabled,poll_window_hours,poll_timeseries_batch_size")
      .eq("id", serviceId)
      .maybeSingle();
    if (data) {
      return data as ServiceRow;
    }
  }

  if (serviceLabel) {
    const { data } = await supabase
      .from("services")
      .select("id,label,service_url,poll_enabled,poll_window_hours,poll_timeseries_batch_size")
      .ilike("label", `%${serviceLabel}%`)
      .limit(1)
      .maybeSingle();
    if (data) {
      return data as ServiceRow;
    }
  }

  const discovered = await discoverService(serviceId, serviceLabel);
  if (!discovered) {
    return null;
  }
  await supabase.from("services").upsert([discovered], { onConflict: "id" });
  return {
    id: discovered.id,
    label: discovered.label,
    service_url: discovered.service_url,
    poll_enabled: true,
    poll_window_hours: DEFAULT_WINDOW_HOURS,
    poll_timeseries_batch_size: null,
  };
}

async function discoverService(
  preferredId: string | undefined,
  preferredLabel: string,
): Promise<{ id: string; label: string; service_url: string } | null> {
  try {
    const data = await fetchJson(UK_AIR_SOS_BASE_URL, "/services", {});
    const services = extractList(data, ["services", "data"]);
    if (!services.length) {
      return null;
    }
    if (preferredId) {
      const match = services.find((svc) => String(svc?.id) === preferredId);
      if (match) {
        return {
          id: String(match.id),
          label: normalizeServiceLabel(match.label || match.name),
          service_url: match.serviceUrl || match.url || UK_AIR_SOS_BASE_URL,
        };
      }
    }
    const needle = preferredLabel.toLowerCase();
    const labelMatch = services.find((svc) =>
      String(svc?.label || "").toLowerCase().includes(needle)
    );
    if (labelMatch) {
      return {
        id: String(labelMatch.id),
        label: normalizeServiceLabel(labelMatch.label || labelMatch.name),
        service_url: labelMatch.serviceUrl || labelMatch.url || UK_AIR_SOS_BASE_URL,
      };
    }
    const fallback = services.find((svc) =>
      String(svc?.label || "").toLowerCase().includes("uk")
        && String(svc?.label || "").toLowerCase().includes("air")
    ) || services[0];
    return {
      id: String(fallback.id),
      label: normalizeServiceLabel(fallback.label || fallback.name),
      service_url: fallback.serviceUrl || fallback.url || UK_AIR_SOS_BASE_URL,
    };
  } catch (err) {
    console.warn("Service discovery failed:", err);
    return null;
  }
}

async function loadTimeseries(
  serviceId: string,
): Promise<Array<{ id: number; source_id: string | null; phenomenon_id: string | null }>> {
  const rows: Array<{ id: number; source_id: string | null; phenomenon_id: string | null }> = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("timeseries")
      .select("id,source_id,phenomenon_id")
      .eq("service_id", serviceId)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      throw new Error(`Failed to load timeseries: ${error.message}`);
    }
    if (!data || data.length === 0) {
      break;
    }
    rows.push(...data.map((row) => ({
      id: Number(row.id),
      source_id: row.source_id ? String(row.source_id) : null,
      phenomenon_id: row.phenomenon_id ? String(row.phenomenon_id) : null,
    })));
    if (data.length < PAGE_SIZE) {
      break;
    }
    offset += PAGE_SIZE;
  }
  return rows;
}

async function loadPhenomena(serviceId: string, filters: string[]): Promise<Set<string>> {
  const needle = new Set(filters.map((value) => value.toLowerCase()));
  const { data, error } = await supabase
    .from("phenomena")
    .select("id,label")
    .eq("service_id", serviceId);
  if (error) {
    throw new Error(`Failed to load phenomena: ${error.message}`);
  }
  const matches = new Set<string>();
  for (const row of data || []) {
    const id = row.id ? String(row.id) : "";
    const label = row.label ? String(row.label) : "";
    if (
      (id && needle.has(id.toLowerCase())) ||
      (label && needle.has(label.toLowerCase()))
    ) {
      if (id) {
        matches.add(id);
      }
    }
  }
  return matches;
}

function extractList(payload: unknown, keys: string[]): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload as Array<Record<string, unknown>>;
  }
  if (payload && typeof payload === "object") {
    for (const key of keys) {
      const items = (payload as Record<string, unknown>)[key];
      if (Array.isArray(items)) {
        return items as Array<Record<string, unknown>>;
      }
    }
  }
  return [];
}

async function fetchJson(
  baseUrl: string,
  path: string,
  params: Record<string, string>,
): Promise<any> {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const resp = await fetch(url.toString(), { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timeout);
  }
}

function parseDatapoints(values: unknown): Array<{ observed_at: string; value: number | null; status: string | null }> {
  if (!Array.isArray(values)) {
    return [];
  }
  const points: Array<{ observed_at: string; value: number | null; status: string | null }> = [];
  for (const row of values) {
    if (!Array.isArray(row) || row.length < 2) {
      continue;
    }
    const timestamp = Number(row[0]);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    const observedAt = new Date(timestamp);
    if (Number.isNaN(observedAt.getTime())) {
      continue;
    }
    const value = toNumber(row[1]);
    const status = row.length > 2 && row[2] != null ? String(row[2]) : null;
    points.push({
      observed_at: observedAt.toISOString(),
      value,
      status,
    });
  }
  return points;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  return num;
}

async function upsertLastValue(
  seriesId: string,
  data: Record<string, unknown>,
  points: Array<{ observed_at: string; value: number | null }>,
): Promise<void> {
  const lastValue = toNumber(data?.lastValue);
  const lastValueTimestamp = data?.lastValueTimestamp;
  let lastValueAt: string | null = null;
  if (typeof lastValueTimestamp === "string") {
    const parsed = new Date(lastValueTimestamp);
    if (!Number.isNaN(parsed.getTime())) {
      lastValueAt = parsed.toISOString();
    }
  } else if (typeof lastValueTimestamp === "number") {
    lastValueAt = new Date(lastValueTimestamp).toISOString();
  } else if (points.length) {
    lastValueAt = points[points.length - 1].observed_at;
  }

  if (!lastValueAt && lastValue === null) {
    return;
  }
  const payload: Record<string, unknown> = { id: seriesId };
  if (lastValueAt) {
    payload.last_value_at = lastValueAt;
  }
  if (lastValue !== null) {
    payload.last_value = lastValue;
  }
  const { error } = await supabase.from("timeseries").upsert(payload, { onConflict: "id" });
  if (error) {
    console.warn(`timeseries update failed for ${seriesId}: ${error.message}`);
  }
}

async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const task = worker(item).finally(() => executing.delete(task));
    executing.add(task);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}
