import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const PORT = Number(Deno.env.get("PORT") || "8080");
const RUN_JOB_SCRIPT = "/app/workers/uk_aq_breathelondon_cloud_run/run_job.ts";
const ALLOWED_TRIGGER_MODES = new Set(["safety", "task", "manual"]);
const CHILD_TIMEOUT_MS = 14 * 60 * 1000;
const CHILD_SHUTDOWN_GRACE_MS = 10 * 1000;

let inFlight = false;

type RunJobResult = {
  success: boolean;
  code: number;
  signal: string | null;
  timedOut: boolean;
  timeoutSeconds?: number;
};

function resolveTriggerMode(req: Request, body: unknown): string {
  const url = new URL(req.url);
  const queryMode = url.searchParams.get("trigger_mode");
  if (queryMode && ALLOWED_TRIGGER_MODES.has(queryMode)) {
    return queryMode;
  }

  const headerMode = (req.headers.get("x-breathelondon-trigger-mode") || "")
    .trim()
    .toLowerCase();
  if (headerMode && ALLOWED_TRIGGER_MODES.has(headerMode)) {
    return headerMode;
  }

  const root = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  const bodyMode = typeof root?.trigger_mode === "string"
    ? root.trigger_mode.trim().toLowerCase()
    : "";
  if (bodyMode && ALLOWED_TRIGGER_MODES.has(bodyMode)) {
    return bodyMode;
  }

  return "manual";
}

async function runJob(
  triggerMode: string,
  currentTaskName: string | null,
): Promise<RunJobResult> {
  const childEnv: Record<string, string> = {
    ...Deno.env.toObject(),
    BREATHELONDON_TRIGGER_MODE: triggerMode,
  };
  if (currentTaskName) {
    childEnv.BREATHELONDON_CURRENT_TASK_NAME = currentTaskName;
  }
  const child = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      RUN_JOB_SCRIPT,
    ],
    env: childEnv,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const statusPromise = child.status;
  statusPromise.catch(() => {
    // Avoid an unhandled rejection if the child exits after the timeout path returns.
  });
  let timeout: number | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), CHILD_TIMEOUT_MS);
  });
  const result = await Promise.race([statusPromise, timeoutPromise]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
  if (result !== "timeout") {
    return {
      success: result.success,
      code: result.code,
      signal: result.signal,
      timedOut: false,
    };
  }

  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "uk_aq_breathelondon_cloud_run",
      message: "child_timeout",
      timeout_seconds: Math.trunc(CHILD_TIMEOUT_MS / 1000),
      trigger_mode: triggerMode,
      current_task_name: currentTaskName,
    }),
  );
  try {
    child.kill("SIGTERM");
  } catch {
    // Child may already have exited between timeout and termination.
  }
  const terminated = await Promise.race([
    statusPromise.then((status) => ({ status })),
    new Promise<"grace_timeout">((resolve) =>
      setTimeout(() => resolve("grace_timeout"), CHILD_SHUTDOWN_GRACE_MS)
    ),
  ]);
  if (terminated === "grace_timeout") {
    try {
      child.kill("SIGKILL");
    } catch {
      // Ignore; statusPromise below will settle if the process is already gone.
    }
    return {
      success: false,
      code: -1,
      signal: "SIGKILL",
      timedOut: true,
      timeoutSeconds: Math.trunc(CHILD_TIMEOUT_MS / 1000),
    };
  }
  const status = terminated.status;
  return {
    success: false,
    code: status.code,
    signal: status.signal,
    timedOut: true,
    timeoutSeconds: Math.trunc(CHILD_TIMEOUT_MS / 1000),
  };
}

serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response(
      JSON.stringify({
        ok: true,
        service: "uk_aq_breathelondon_cloud_run",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (inFlight) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "run_in_flight",
      }),
      {
        status: 409,
        headers: { "content-type": "application/json" },
      },
    );
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const triggerMode = resolveTriggerMode(req, body);
  const currentTaskName =
    (req.headers.get("x-cloudtasks-taskname") || "").trim() || null;

  inFlight = true;
  try {
    const result = await runJob(triggerMode, currentTaskName);
    return new Response(
      JSON.stringify({
        ok: result.success,
        trigger_mode: triggerMode,
        current_task_name: currentTaskName,
        code: result.code,
        signal: result.signal,
        timed_out: result.timedOut,
        timeout_seconds: result.timeoutSeconds ?? null,
      }),
      {
        status: result.timedOut ? 504 : result.success ? 200 : 500,
        headers: { "content-type": "application/json" },
      },
    );
  } finally {
    inFlight = false;
  }
}, { port: PORT });
