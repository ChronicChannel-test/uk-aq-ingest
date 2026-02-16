#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Sync GitHub Actions repo secrets from local env files.

Usage:
  scripts/uk_aq_sync_github_secrets.sh [options]

Options:
  --repo <owner/name>            GitHub repo (default: current gh repo)
  --env-file <path>              Env file for per-secret key/value sync (default: .env)
  --supabase-env-file <path>     Env file to upload as SUPABASE_SECRETS_ENV (default: .env.supabase)
  --targets-file <path>          CSV map of KEY -> target(secret|variable|both) (default: config/uk_aq_github_env_targets.csv)
  --dry-run                      Show what would be updated without changing secrets
  -h, --help                     Show help

Notes:
  - Routing is controlled by --targets-file. Unmapped keys default to secret.
  - The full contents of --supabase-env-file are also uploaded to SUPABASE_SECRETS_ENV.
  - For GCP_SA_KEY, if VALUE is a path to a local file, the file contents are uploaded.
EOF
}

REPO=""
ENV_FILE=".env"
SUPABASE_ENV_FILE=".env.supabase"
TARGETS_FILE="config/uk_aq_github_env_targets.csv"
DRY_RUN=0
SEEN_FILE="$(mktemp)"
TARGETS_CACHE_FILE="$(mktemp)"

cleanup() {
  rm -f "${SEEN_FILE}"
  rm -f "${TARGETS_CACHE_FILE}"
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --supabase-env-file)
      SUPABASE_ENV_FILE="${2:-}"
      shift 2
      ;;
    --targets-file)
      TARGETS_FILE="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

HAS_GH=1
if ! command -v gh >/dev/null 2>&1; then
  HAS_GH=0
fi

if [[ -z "${REPO}" && "${HAS_GH}" -eq 1 ]]; then
  REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)"
fi
if [[ -z "${REPO}" ]]; then
  echo "Could not determine GitHub repo. Pass --repo owner/name." >&2
  exit 1
fi

if [[ "${HAS_GH}" -eq 0 && "${DRY_RUN}" -eq 0 ]]; then
  echo "gh CLI is required for non-dry-run execution." >&2
  exit 1
fi

if [[ "${DRY_RUN}" -eq 0 ]]; then
  gh auth status >/dev/null
fi

load_targets_map() {
  local file="$1"
  if [[ ! -f "${file}" ]]; then
    echo "Targets file not found: ${file}" >&2
    exit 1
  fi

  python3 - "${file}" "${TARGETS_CACHE_FILE}" <<'PY'
import csv
import re
import sys
from pathlib import Path

source = Path(sys.argv[1])
output = Path(sys.argv[2])

allowed_targets = {"secret", "variable", "both"}
key_re = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
seen = {}

with source.open("r", encoding="utf-8", newline="") as handle:
    reader = csv.DictReader(handle)
    if not reader.fieldnames:
        raise SystemExit(f"Targets file is empty: {source}")
    normalized = {name.strip().lower(): name for name in reader.fieldnames}
    if "key" not in normalized or "target" not in normalized:
        raise SystemExit(
            f"Targets file must contain 'key' and 'target' columns: {source}"
        )
    key_col = normalized["key"]
    target_col = normalized["target"]

    for idx, row in enumerate(reader, start=2):
        raw_key = (row.get(key_col) or "").strip()
        raw_target = (row.get(target_col) or "").strip().lower()
        if not raw_key:
            continue
        if not key_re.match(raw_key):
            raise SystemExit(
                f"Invalid key '{raw_key}' at {source}:{idx}. "
                "Keys must match [A-Za-z_][A-Za-z0-9_]*."
            )
        if raw_target not in allowed_targets:
            raise SystemExit(
                f"Invalid target '{raw_target}' for key '{raw_key}' at {source}:{idx}. "
                "Allowed: secret, variable, both."
            )
        previous = seen.get(raw_key)
        if previous and previous != raw_target:
            raise SystemExit(
                f"Conflicting targets for key '{raw_key}': '{previous}' vs '{raw_target}'."
            )
        seen[raw_key] = raw_target

with output.open("w", encoding="utf-8") as handle:
    for key in sorted(seen):
        handle.write(f"{key}\t{seen[key]}\n")
PY
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value}"
}

set_secret() {
  local name="$1"
  local value="$2"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] would set ${name} (len=${#value})"
  else
    printf '%s' "${value}" | gh secret set "${name}" --repo "${REPO}"
    echo "set ${name}"
  fi
  printf '%s\n' "${name}" >> "${SEEN_FILE}"
}

set_variable() {
  local name="$1"
  local value="$2"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] would set variable ${name}=${value}"
  else
    gh variable set "${name}" --repo "${REPO}" --body "${value}"
    echo "set variable ${name}"
  fi
}

target_for_key() {
  local key="$1"
  local target
  target="$(awk -F $'\t' -v key="${key}" '$1 == key { print $2; exit }' "${TARGETS_CACHE_FILE}")"
  if [[ -z "${target}" ]]; then
    echo "secret"
    return 0
  fi
  echo "${target}"
}

resolve_secret_value() {
  local key="$1"
  local value="$2"

  if [[ "${key}" == "GCP_SA_KEY" && -f "${value}" ]]; then
    cat "${value}"
    return 0
  fi

  if [[ "${key}" == "SUPABASE_DB_URL" ]]; then
    python3 - "${value}" <<'PY'
import sys
from urllib.parse import quote, unquote, urlsplit, urlunsplit

raw = sys.argv[1]
try:
    parsed = urlsplit(raw)
except Exception:
    print(raw)
    raise SystemExit(0)

if not parsed.scheme or not parsed.netloc or parsed.password is None:
    print(raw)
    raise SystemExit(0)

username = parsed.username or ""
password = parsed.password or ""
hostname = parsed.hostname or ""
host = f"[{hostname}]" if ":" in hostname and not hostname.startswith("[") else hostname
port = f":{parsed.port}" if parsed.port else ""

userinfo = username
if parsed.password is not None:
    # urlsplit keeps percent escapes in parsed.password.
    # Decode once to canonical text, then re-encode once to avoid accidental double-encoding.
    canonical_password = unquote(password)
    userinfo = f"{username}:{quote(canonical_password, safe='')}"

netloc = f"{userinfo}@{host}{port}"
encoded = urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment))
print(encoded)
PY
    return 0
  fi

  printf '%s' "${value}"
}

sync_env_vars() {
  local file="$1"
  if [[ ! -f "${file}" ]]; then
    echo "skip missing file: ${file}" >&2
    return 0
  fi

  while IFS= read -r raw_line || [[ -n "${raw_line}" ]]; do
    local line key value first_char last_char target
    line="${raw_line%$'\r'}"
    line="$(trim "${line}")"
    [[ -z "${line}" ]] && continue
    [[ "${line}" == \#* ]] && continue
    [[ "${line}" == export\ * ]] && line="${line#export }"
    [[ "${line}" != *=* ]] && continue

    key="$(trim "${line%%=*}")"
    value="${line#*=}"
    value="$(trim "${value}")"

    if [[ ! "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "skip invalid key in ${file}: ${key}" >&2
      continue
    fi

    first_char="${value:0:1}"
    last_char="${value: -1}"
    if [[ "${#value}" -ge 2 && "${first_char}" == '"' && "${last_char}" == '"' ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${#value}" -ge 2 && "${first_char}" == "'" && "${last_char}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi

    value="$(resolve_secret_value "${key}" "${value}")"
    target="$(target_for_key "${key}")"
    case "${target}" in
      secret)
        set_secret "${key}" "${value}"
        ;;
      variable)
        set_variable "${key}" "${value}"
        ;;
      both)
        set_variable "${key}" "${value}"
        set_secret "${key}" "${value}"
        ;;
      *)
        echo "Invalid target '${target}' for key '${key}' from ${TARGETS_FILE}" >&2
        exit 1
        ;;
    esac
  done < "${file}"
}

load_targets_map "${TARGETS_FILE}"
sync_env_vars "${ENV_FILE}"
sync_env_vars "${SUPABASE_ENV_FILE}"

if [[ -f "${SUPABASE_ENV_FILE}" ]]; then
  set_secret "SUPABASE_SECRETS_ENV" "$(cat "${SUPABASE_ENV_FILE}")"
fi

WORKFLOW_DIR=".github/workflows"
if [[ -d "${WORKFLOW_DIR}" ]]; then
  REQUIRED_FILE="$(mktemp)"
  trap 'cleanup; rm -f "${REQUIRED_FILE}"' EXIT
  if command -v rg >/dev/null 2>&1; then
    rg -n "secrets\\.[A-Z0-9_]+" "${WORKFLOW_DIR}"/*.yml \
      | sed -E 's/.*secrets\.([A-Z0-9_]+).*/\1/' \
      | sort -u > "${REQUIRED_FILE}"
  else
    grep -RnoE "secrets\\.[A-Z0-9_]+" "${WORKFLOW_DIR}" --include="*.yml" \
      | sed -E 's/.*secrets\.([A-Z0-9_]+).*/\1/' \
      | sort -u > "${REQUIRED_FILE}"
  fi

  sort -u "${SEEN_FILE}" -o "${SEEN_FILE}"
  MISSING="$(comm -23 "${REQUIRED_FILE}" "${SEEN_FILE}" || true)"
  if [[ -n "${MISSING}" ]]; then
    echo
    echo "Secrets referenced by workflows but not set from env files:"
    echo "${MISSING}"
  fi
fi

echo
echo "Done for ${REPO}."
