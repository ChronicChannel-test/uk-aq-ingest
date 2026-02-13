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
  --dry-run                      Show what would be updated without changing secrets
  -h, --help                     Show help

Notes:
  - Each KEY=VALUE in --env-file and --supabase-env-file is uploaded as a secret named KEY.
  - The full contents of --supabase-env-file are also uploaded to SUPABASE_SECRETS_ENV.
  - For GCP_SA_KEY, if VALUE is a path to a local file, the file contents are uploaded.
EOF
}

REPO=""
ENV_FILE=".env"
SUPABASE_ENV_FILE=".env.supabase"
DRY_RUN=0
SEEN_FILE="$(mktemp)"

cleanup() {
  rm -f "${SEEN_FILE}"
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
from urllib.parse import quote, urlsplit, urlunsplit

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
    userinfo = f"{username}:{quote(password, safe='')}"

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
    local line key value first_char last_char
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
    set_secret "${key}" "${value}"
  done < "${file}"
}

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
