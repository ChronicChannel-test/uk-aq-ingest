#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PID_FILE="$ROOT_DIR/.dashboards.pids"
LOG_DIR="$ROOT_DIR/logs"
SCHED_LOG="$LOG_DIR/scheduler.log"
SNAP_LOG="$LOG_DIR/station_snapshot.log"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required." >&2
  exit 1
fi

set -a
if [[ -f "$ROOT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
fi
if [[ -f "$ROOT_DIR/.env.supabase" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env.supabase"
fi
set +a

if [[ -z "${SUPABASE_URL:-}" && -n "${SB_SUPABASE_URL:-}" ]]; then
  export SUPABASE_URL="$SB_SUPABASE_URL"
fi
if [[ -z "${SUPABASE_ANON_KEY:-}" && -n "${SB_PUBLISHABLE_DEFAULT_KEY:-}" ]]; then
  export SUPABASE_ANON_KEY="$SB_PUBLISHABLE_DEFAULT_KEY"
fi

missing_vars=()
[[ -n "${SUPABASE_URL:-}" ]] || missing_vars+=("SUPABASE_URL")
[[ -n "${SUPABASE_ANON_KEY:-}" ]] || missing_vars+=("SUPABASE_ANON_KEY")
if [[ -z "${UK_AQ_DEV_JWT:-}" && -z "${UK_AQ_DEV_REFRESH_TOKEN:-}" ]]; then
  missing_vars+=("UK_AQ_DEV_JWT or UK_AQ_DEV_REFRESH_TOKEN")
fi
if (( ${#missing_vars[@]} > 0 )); then
  echo "Missing required environment variables: ${missing_vars[*]}" >&2
  exit 1
fi

HOST="${HOST:-127.0.0.1}"
SCHEDULER_PORT="${SCHEDULER_PORT:-8045}"
SNAPSHOT_PORT="${SNAPSHOT_PORT:-8046}"

is_running() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

if [[ -f "$PID_FILE" ]]; then
  already_running=0
  while IFS=':' read -r _label pid; do
    [[ -n "$pid" ]] || continue
    if is_running "$pid"; then
      already_running=1
    fi
  done < "$PID_FILE"
  if [[ "$already_running" -eq 1 ]]; then
    echo "Dashboards appear to be already running. Stop first with ./dev_dashboards_stop.sh" >&2
    exit 1
  fi
  rm -f "$PID_FILE"
fi

mkdir -p "$LOG_DIR"

python3 scripts/uk_aq_dashboard_local.py --host "$HOST" --port "$SCHEDULER_PORT" >>"$SCHED_LOG" 2>&1 &
SCHED_PID=$!

python3 scripts/uk_aq_station_snapshot_local.py --host "$HOST" --port "$SNAPSHOT_PORT" >>"$SNAP_LOG" 2>&1 &
SNAP_PID=$!

cat > "$PID_FILE" <<EOF
scheduler:$SCHED_PID
station_snapshot:$SNAP_PID
EOF

cleanup() {
  local pid
  for pid in "$SCHED_PID" "$SNAP_PID"; do
    if is_running "$pid"; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait "$SCHED_PID" 2>/dev/null || true
  wait "$SNAP_PID" 2>/dev/null || true
  rm -f "$PID_FILE"
}

trap cleanup INT TERM EXIT

echo "Scheduler dashboard: http://$HOST:$SCHEDULER_PORT"
echo "Station snapshot dashboard: http://$HOST:$SNAPSHOT_PORT"
echo "Logs: $SCHED_LOG, $SNAP_LOG"

wait "$SCHED_PID" "$SNAP_PID"
