# Comprehensive Code Review Report
## UK Air Quality Networks Repository

**Review Date:** 2026-01-15  
**Repository:** ChronicChannel-test/uk-air-quality-networks  
**Review Scope:** Full repository - Python scripts, TypeScript edge functions, SQL schema, GitHub Actions

---

## Executive Summary

This report documents security vulnerabilities, bugs, code quality issues, and potential improvements found during a comprehensive code review of the UK Air Quality Networks repository. Issues are categorized by severity (CRITICAL, HIGH, MEDIUM, LOW) with detailed remediation recommendations including pros and cons of each approach.

**Key Statistics:**
- 19 Python scripts reviewed
- 8 TypeScript edge functions reviewed
- 7 SQL schema/migration files reviewed
- 7 GitHub Actions workflows reviewed
- **Total Issues Found:** 25

**Severity Breakdown:**
- 🔴 CRITICAL: 2
- 🟠 HIGH: 7
- 🟡 MEDIUM: 11
- 🔵 LOW: 5

---

## 🔴 CRITICAL SEVERITY ISSUES

### ISSUE #1: Hardcoded Local File Path Exposes Developer Machine Structure

**Location:** `scripts/get_uk_sensors.py:33`

**Problem:**
```python
API_KEY_FILE = '/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/Resources/PurpleAir/Purpleair-Read-APIkey.txt'
```

**Severity:** CRITICAL  
**Category:** Security / Maintainability

**Impact:**
- Script will fail in any non-developer environment (CI/CD, production, other developers)
- Exposes internal file structure and developer username
- Creates single point of failure
- Security risk if credentials path becomes known

**Remediation Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **Option 1: Environment Variable Only** | Remove hardcoded path, use `PURPLEAIR_API_KEY` env var directly | ✅ Secure<br>✅ Portable<br>✅ CI/CD friendly | ❌ Requires updating CI secrets |
| **Option 2: Env Var with Fallback** | Check `PURPLEAIR_API_KEY` env var first, fall back to `API_KEY_FILE` path from env | ✅ Backward compatible<br>✅ Flexible | ❌ More complex<br>❌ Still allows file-based keys |
| **Option 3: Remove Script Entirely** | Archive script if PurpleAir isn't actively used | ✅ Reduces attack surface<br>✅ Less maintenance | ❌ Loses functionality |

**Recommended Fix: Option 1**

Change `scripts/get_uk_sensors.py` line 64-79 to:

```python
def _load_api_key(self) -> str:
    """Load API key from environment variable"""
    api_key = os.getenv('PURPLEAIR_API_KEY', '').strip()
    if not api_key:
        logger.error("PURPLEAIR_API_KEY environment variable not set")
        sys.exit(1)
    return api_key
```

**Estimated Effort:** 5 minutes

---

### ISSUE #2: TypeScript Type Checking Completely Disabled

**Location:** All 8 edge function files (`supabase/functions/*/index.ts`)

**Problem:**
```typescript
// @ts-nocheck
```

**Severity:** CRITICAL  
**Category:** Code Quality / Safety

**Impact:**
- Silent runtime errors from type mismatches
- Null/undefined reference errors at runtime
- Harder to refactor safely
- Loss of IDE autocomplete and IntelliSense
- Higher bug introduction rate

**Examples of Potential Runtime Errors:**
- `row.phenomenon?.label` might access undefined
- Unchecked array access could throw
- String/number mismatches in API responses

**Remediation Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **Option 1: Enable TypeScript Strict Mode** | Remove `@ts-nocheck`, add proper types | ✅ Full type safety<br>✅ Catches bugs early<br>✅ Better IDE support | ❌ Significant upfront work<br>❌ May require Deno types rework |
| **Option 2: Gradual Migration** | Start with `@ts-check` (less strict), fix errors incrementally | ✅ Incremental approach<br>✅ Less disruptive | ❌ Still allows some type issues<br>❌ Slower path to safety |
| **Option 3: Add Runtime Validation** | Keep `@ts-nocheck` but add Zod/Ajv schema validation | ✅ Runtime safety<br>✅ API contract validation | ❌ Doesn't catch logic errors<br>❌ Performance overhead |

**Recommended Fix: Option 2 → Option 1 (Phased Approach)**

Phase 1: Replace `@ts-nocheck` with `@ts-check` + `// @ts-expect-error` for known issues  
Phase 2: Fix type errors one file at a time  
Phase 3: Enable strict mode once errors resolved

**Estimated Effort:** 8-16 hours (all files)

---

## 🟠 HIGH SEVERITY ISSUES

### ISSUE #3: Missing Environment Variable Validation at Startup

**Location:** Multiple files - Python scripts and TypeScript functions

**Problem:**
Scripts proceed even when critical environment variables are missing, failing later during execution.

**Affected Files:**
- `scripts/uk_air_sos_ingest.py` (Dropbox credentials)
- `scripts/sensorcommunity_ingest.py` (Dropbox credentials)
- `supabase/functions/ingest_uk_air_sos/index.ts` (Supabase URL/key)

**Severity:** HIGH  
**Category:** Reliability / Error Handling

**Impact:**
- Wasted compute time/API credits before failure
- Unclear error messages
- Partial data corruption if failure mid-process
- Difficult debugging

**Examples:**
```python
# scripts/uk_air_sos_ingest.py:587-591
app_secret = os.getenv("DROPBOX_APP_SECRET", "").strip()
refresh_token = os.getenv("DROPBOX_REFRESH_TOKEN", "").strip()
if not (app_key and app_secret and refresh_token):
    LOG.warning("Dropbox credentials missing; skipping error Dropbox upload.")
    return None  # ❌ Continues execution silently
```

**Remediation Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **Option 1: Fail Fast** | Raise SystemExit if required vars missing | ✅ Clear failure point<br>✅ Prevents partial work | ❌ Less flexible for optional features |
| **Option 2: Startup Validation Function** | Create `validate_environment()` function called at start | ✅ Centralized logic<br>✅ Easy to test | ❌ Requires code changes across files |
| **Option 3: Schema Validation Library** | Use `pydantic-settings` for Python, `envalid` for TypeScript | ✅ Declarative<br>✅ Type-safe | ❌ New dependency<br>❌ Learning curve |

**Recommended Fix: Option 2**

Add to Python scripts:
```python
def validate_required_environment() -> None:
    """Validate required environment variables at startup."""
    required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        raise SystemExit(f"Missing required environment variables: {', '.join(missing)}")

# Call early in main()
validate_required_environment()
```

**Estimated Effort:** 2-3 hours

---

### ISSUE #4: No SQL Injection Protection for User Inputs

**Location:** `supabase/functions/uk_aq_latest/index.ts:136-142`

**Problem:**
User-supplied query parameters used directly in Supabase filter without validation:

```typescript
if (region) {
  baseParams["stations.region"] = `ilike.*${region}*`;  // ❌ No sanitization
}
if (pconCode) {
  baseParams["stations.pcon_code"] = `eq.${pconCode}`;  // ❌ No sanitization
}
```

**Severity:** HIGH  
**Category:** Security

**Impact:**
- Potential PostgREST filter injection
- Data exfiltration via crafted queries
- Denial of service via complex regex patterns
- Though Supabase uses parameterized queries internally, malicious filter operators could be injected

**Attack Vector Example:**
```
?region=*&stations.id=gte.0&stations.id=lte.999999999
```

**Remediation Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **Option 1: Input Whitelist** | Allow only alphanumeric + hyphen/underscore | ✅ Simple<br>✅ Effective | ❌ May block valid region names |
| **Option 2: Schema Validation** | Use Zod to validate inputs against expected format | ✅ Comprehensive<br>✅ Type-safe | ❌ Dependency<br>❌ Complexity |
| **Option 3: Supabase Client Library** | Use `@supabase/supabase-js` instead of raw REST | ✅ Built-in escaping<br>✅ Type-safe | ❌ Different API<br>❌ Requires refactor |

**Recommended Fix: Option 1 + Option 2**

```typescript
function sanitizeInput(value: string | null, pattern: RegExp): string | null {
  if (!value) return null;
  const cleaned = value.trim();
  if (!cleaned || !pattern.test(cleaned)) return null;
  return cleaned;
}

const REGION_PATTERN = /^[a-zA-Z0-9\s\-]+$/;
const PCON_CODE_PATTERN = /^[A-Z][0-9]{8}$/;  // GSS code format

const region = sanitizeInput(url.searchParams.get("region"), REGION_PATTERN);
const pconCode = sanitizeInput(url.searchParams.get("pcon_code"), PCON_CODE_PATTERN);
```

**Estimated Effort:** 4 hours

---

### ISSUE #5: Coordinate Swap Logic Has Edge Cases

**Location:** `scripts/ingest_helpers.py:13-26`

**Problem:**
```python
def maybe_swap_coords(
    lon: Optional[float], lat: Optional[float], bbox: Optional[Dict[str, float]]
) -> Tuple[Optional[float], Optional[float]]:
    if lon is None or lat is None or bbox is None:
        return lon, lat
    # If values look swapped for the bbox, swap them.
    if (
        bbox["south"] <= lon <= bbox["north"]
        and bbox["west"] <= lat <= bbox["east"]
        and not (bbox["west"] <= lon <= bbox["east"])
        and not (bbox["south"] <= lat <= bbox["north"])
    ):
        return lat, lon
    return lon, lat
```

**Severity:** HIGH  
**Category:** Data Integrity

**Impact:**
- Stations could be placed at incorrect coordinates
- Spatial queries fail
- Map display shows wrong locations
- Affects parliamentary constituency matching

**Edge Cases Not Handled:**
1. Coordinates outside all bboxes (returns original, even if swapped)
2. Coordinates in multiple overlapping bboxes (ambiguous)
3. Coordinates near bbox boundaries (false positives)
4. No logging when swap occurs (hard to debug)

**Remediation Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **Option 1: Add Validation Range Check** | Validate lat in [-90,90], lon in [-180,180] first | ✅ Catches obvious errors<br>✅ Simple | ❌ Doesn't fix ambiguous cases |
| **Option 2: Log All Swaps** | Add logging when coordinates are swapped | ✅ Debuggable<br>✅ Audit trail | ❌ Doesn't prevent bugs |
| **Option 3: Explicit Coordinate Order** | Require callers to specify coordinate order | ✅ No ambiguity<br>✅ Type-safe | ❌ Breaking change<br>❌ More verbose |

**Recommended Fix: Option 1 + Option 2**

```python
def maybe_swap_coords(
    lon: Optional[float], lat: Optional[float], bbox: Optional[Dict[str, float]]
) -> Tuple[Optional[float], Optional[float]]:
    if lon is None or lat is None or bbox is None:
        return lon, lat
    
    # Validate range first
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        if (-180 <= lat <= 180 and -90 <= lon <= 90):
            LOG.warning(f"Swapping coords: lon={lon}, lat={lat}")
            return lat, lon
        LOG.error(f"Invalid coordinates: lon={lon}, lat={lat}")
        return None, None
    
    # Rest of logic...
```

**Estimated Effort:** 2 hours + testing

---

### ISSUE #6: Unhandled Dropbox Token Expiration

**Location:** `scripts/uk_air_sos_ingest.py:302-316` and similar in other files

**Problem:**
Dropbox access token refresh has no expiration checks or retry logic:

```python
def _dropbox_refresh_access_token(config: DropboxConfig) -> str:
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": config.refresh_token,
        "client_id": config.app_key,
        "client_secret": config.app_secret,
    }
    resp = requests.post(DROPBOX_TOKEN_URL, data=payload, timeout=30)
    if resp.status_code >= 400:
        raise RuntimeError(f"Dropbox token request failed ({resp.status_code}): {resp.text}")
    data = resp.json()
    token = data.get("access_token")
    if not token:
        raise RuntimeError("Dropbox token response missing access_token.")
    return token
```

**Severity:** HIGH  
**Category:** Reliability

**Impact:**
- Failed Dropbox uploads mid-process
- Lost error logs
- No automatic recovery

**Issues:**
1. No `expires_in` tracking
2. No token caching between requests
3. Single failure point (no retries)
4. No exponential backoff

**Remediation Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **Option 1: Add Token Caching** | Store token + expiry time, refresh only when expired | ✅ Reduces API calls<br>✅ More efficient | ❌ Requires state management |
| **Option 2: Retry with Exponential Backoff** | Use `requests` retry adapter | ✅ Handles transient failures<br>✅ Standard pattern | ❌ Doesn't handle expiration |
| **Option 3: Use Official Dropbox SDK** | Replace custom code with `dropbox` library | ✅ Handles auth automatically<br>✅ Well-tested | ❌ New dependency<br>❌ API changes |

**Recommended Fix: Option 1 + Option 2**

```python
@dataclass
class TokenCache:
    access_token: str
    expires_at: datetime

_token_cache: Optional[TokenCache] = None

def _dropbox_refresh_access_token(config: DropboxConfig) -> str:
    global _token_cache
    now = utcnow()
    if _token_cache and _token_cache.expires_at > now:
        return _token_cache.access_token
    
    for attempt in range(1, 4):
        try:
            resp = requests.post(DROPBOX_TOKEN_URL, data=payload, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            token = data.get("access_token")
            expires_in = data.get("expires_in", 14400)
            _token_cache = TokenCache(
                access_token=token,
                expires_at=now + timedelta(seconds=expires_in - 300)  # 5min buffer
            )
            return token
        except requests.RequestException as exc:
            if attempt == 3:
                raise
            time.sleep(min(30, 2**attempt))
```

**Estimated Effort:** 3 hours

---

### ISSUE #7: Missing Rate Limiting on External API Calls

**Location:** `scripts/uk_air_sos_ingest.py:652-698` (UkAirClient.get)

**Problem:**
```python
def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    url = f"{self.base_url}/{path.lstrip('/')}"
    for attempt in range(1, self.retries + 1):
        try:
            resp = self.session.get(url, params=params, timeout=self.timeout)
            # ...retries on 429/5xx but no proactive rate limiting
```

**Severity:** HIGH  
**Category:** Reliability / Performance

**Impact:**
- Could hit UK-AIR SOS API rate limits
- Script failures mid-backfill
- Potential IP blocking
- Wasted retries

**Issues:**
1. No request throttling
2. Reactive (waits for 429) instead of proactive
3. Exponential backoff too aggressive (2^attempt)
4. No circuit breaker pattern

**Remediation Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **Option 1: Token Bucket Rate Limiter** | Track requests per window, sleep if exceeded | ✅ Prevents 429s<br>✅ Smooth rate | ❌ Requires state<br>❌ Complex |
| **Option 2: Simple Sleep Between Requests** | Add 0.1-0.5s delay after each request | ✅ Simple<br>✅ Effective | ❌ Slows down all requests |
| **Option 3: Use `ratelimit` Library** | Use Python `ratelimit` decorator | ✅ Standard library<br>✅ Easy to tune | ❌ Dependency |

**Recommended Fix: Option 2 + Improved Backoff**

```python
import time
import random

RATE_LIMIT_DELAY = 0.2  # 200ms between requests

def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    url = f"{self.base_url}/{path.lstrip('/')}"
    for attempt in range(1, self.retries + 1):
        try:
            resp = self.session.get(url, params=params, timeout=self.timeout)
            if resp.status_code in (429, 500, 502, 503, 504):
                delay = min(60, (2**attempt) + random.uniform(0, 1))  # Jitter
                time.sleep(delay)
                continue
            resp.raise_for_status()
            time.sleep(RATE_LIMIT_DELAY)  # Proactive throttling
            return resp.json()
        # ...rest of exception handling
```

**Estimated Effort:** 2 hours

---

### ISSUE #8: Insufficient Error Context in Exception Handling

**Location:** Multiple files

**Problem:**
Exceptions caught but logged without sufficient context:

```python
# scripts/uk_air_sos_ingest.py:1773-1781
except Exception as exc:
    errors += 1
    LOG.debug("Backfill failed for %s: %s", ts_ref, exc)
    self._log_error(
        "Backfill failed for timeseries.",
        exc,
        context={"timeseries_ref": ts_ref, "year": year},  # ❌ Missing timespan, chunk info
        connector_id=connector_id,
        timeseries_id=ts_db_id,
    )
```

**Severity:** HIGH  
**Category:** Maintainability / Debugging

**Impact:**
- Hard to debug production issues
- Incomplete error logs in Dropbox
- Cannot reproduce failures
- Missing correlation IDs

**Remediation Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **Option 1: Structured Logging** | Use `structlog` or `python-json-logger` | ✅ Machine-parseable<br>✅ Rich context | ❌ Dependency<br>❌ Format change |
| **Option 2: Add Request ID Tracking** | Generate unique ID per script run | ✅ Correlation<br>✅ Simple | ❌ Doesn't solve context issue |
| **Option 3: Comprehensive Context Dict** | Include all relevant variables in context | ✅ No dependencies<br>✅ Immediate benefit | ❌ Manual work |

**Recommended Fix: Option 3**

```python
context = {
    "timeseries_ref": ts_ref,
    "year": year,
    "chunk_start": chunk_start.isoformat(),
    "chunk_end": chunk_end.isoformat(),
    "timespan": timespan,
    "chunk_days": chunk_days,
    "attempt": idx,
    "total": total,
}
```

**Estimated Effort:** 4 hours (all files)

---

### ISSUE #9: No Production requirements.txt File

**Location:** Root directory

**Problem:**
Only `requirements-dev.txt` exists. No base `requirements.txt` for production dependencies.

**Current State:**
```
requirements-dev.txt (contains pytest, responses)
```

**Severity:** HIGH  
**Category:** DevOps / Deployment

**Impact:**
- Unclear production dependencies
- Dev dependencies installed in production
- Larger container images
- Potential security vulnerabilities from dev tools

**Remediation Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **Option 1: Create requirements.txt** | Split into base + dev files | ✅ Standard practice<br>✅ Clear separation | ❌ Manual maintenance |
| **Option 2: Use pyproject.toml** | Modern Python packaging with optional deps | ✅ Single source of truth<br>✅ PEP standard | ❌ Requires Poetry/pip-tools |
| **Option 3: Use Pipfile** | Pipenv for dependency management | ✅ Automatic dep resolution<br>✅ Lock file | ❌ Tool requirement<br>❌ Slower adoption |

**Recommended Fix: Option 1**

Create `requirements.txt`:
```
requests>=2.31.0
python-dotenv>=1.0.0
supabase>=2.0.0
```

Update `requirements-dev.txt`:
```
-r requirements.txt
pytest>=7.4.0
responses>=0.23.0
```

**Estimated Effort:** 30 minutes

---

## 🟡 MEDIUM SEVERITY ISSUES

### ISSUE #10: Missing .env.example File

**Location:** Root directory

**Problem:**
No template file documenting required environment variables.

**Severity:** MEDIUM  
**Category:** Documentation / Onboarding

**Impact:**
- New developers don't know what vars to set
- Inconsistent configurations
- Trial-and-error setup

**Remediation:**

Create `.env.example`:
```bash
# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here

# UK-AIR SOS Configuration
UK_AIR_SOS_BASE_URL=https://uk-air.defra.gov.uk/sos-ukair/api/v1
UK_AIR_SOS_SERVICE_LABEL=UK-AIR-SOS

# Dropbox Configuration (Optional - for raw data/error logging)
DROPBOX_APP_KEY=your_dropbox_app_key
DROPBOX_APP_SECRET=your_dropbox_app_secret
DROPBOX_REFRESH_TOKEN=your_dropbox_refresh_token
UK_AIR_RAW_DROPBOX_ALLOWED_SUPABASE_URL=https://your-project.supabase.co

# PurpleAir Configuration (Optional)
PURPLEAIR_API_KEY=your_purpleair_api_key

# Logging
UK_AIR_LOG_LEVEL=INFO
UK_AIR_FILE_LOG_LEVEL=INFO
```

**Estimated Effort:** 15 minutes

---

### ISSUE #11: Inconsistent Logging Configuration

**Location:** All Python scripts

**Problem:**
Each script configures logging independently:

```python
# scripts/uk_air_sos_ingest.py:51-54
logging.basicConfig(
    level=getattr(logging, DEFAULT_LOG_LEVEL, logging.WARNING),
    format="%(asctime)s %(levelname)s %(message)s",
)

# scripts/get_uk_sensors.py:52-59  (different format)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('purpleair_fetch.log'),
        logging.StreamHandler()
    ]
)
```

**Severity:** MEDIUM  
**Category:** Code Quality

**Impact:**
- Inconsistent log formats
- Hard to aggregate logs
- No structured logging
- Difficult to parse programmatically

**Remediation:**

Create `scripts/logging_config.py`:
```python
import logging
import os
from typing import Optional

def configure_logging(
    logger_name: str,
    console_level: Optional[str] = None,
    file_level: Optional[str] = None,
    log_file: Optional[str] = None,
) -> logging.Logger:
    """Configure consistent logging across scripts."""
    console_level = console_level or os.getenv("UK_AIR_LOG_LEVEL", "INFO")
    file_level = file_level or os.getenv("UK_AIR_FILE_LOG_LEVEL", "DEBUG")
    
    logger = logging.getLogger(logger_name)
    logger.setLevel(logging.DEBUG)
    
    # Console handler
    console = logging.StreamHandler()
    console.setLevel(getattr(logging, console_level.upper()))
    console.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    ))
    logger.addHandler(console)
    
    # File handler (optional)
    if log_file:
        file_handler = logging.FileHandler(log_file)
        file_handler.setLevel(getattr(logging, file_level.upper()))
        file_handler.setFormatter(logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s:%(lineno)d: %(message)s"
        ))
        logger.addHandler(file_handler)
    
    return logger
```

**Estimated Effort:** 3 hours

---

### ISSUE #12: No Input Validation in Edge Functions

**Location:** All TypeScript edge functions

**Problem:**
User inputs accepted without schema validation:

```typescript
// supabase/functions/uk_aq_latest/index.ts:73-85
const region = normalizeText(url.searchParams.get("region"));  // Only trims
const pconCode = normalizeText(url.searchParams.get("pcon_code"));  // Only trims
const limit = parseLimit(url.searchParams.get("limit"), DEFAULT_LIMIT);
```

**Severity:** MEDIUM  
**Category:** Security / Data Validation

**Impact:**
- Unexpected query behavior
- Potential injection attacks
- Poor error messages
- Performance issues (complex queries)

**Remediation:**

Use Zod for schema validation:
```typescript
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

const QuerySchema = z.object({
  region: z.string().max(100).regex(/^[a-zA-Z\s\-]+$/).optional(),
  pcon_code: z.string().regex(/^[A-Z][0-9]{8}$/).optional(),
  pollutant: z.enum(["pm2.5", "pm10", "no2", "o3"]).optional(),
  limit: z.number().int().min(1).max(10000).default(1000),
});

// In handler
const params = QuerySchema.safeParse({
  region: url.searchParams.get("region"),
  pcon_code: url.searchParams.get("pcon_code"),
  pollutant: url.searchParams.get("pollutant"),
  limit: Number(url.searchParams.get("limit")) || undefined,
});

if (!params.success) {
  return json({ error: "Invalid parameters", issues: params.error.issues }, 400);
}
```

**Estimated Effort:** 6 hours (all functions)

---

### ISSUE #13: Potential Race Condition in Dropbox Log Archival

**Location:** `scripts/uk_air_sos_ingest.py:440-535`

**Problem:**
Archive logic has race condition potential:

```python
# Line 491-493
if archive_name not in existing_archives:
    zip_payload = _dropbox_download_zip(access_token, folder_path)
    _dropbox_upload_bytes(access_token, zip_payload, archive_path)
# Line 494-505
delete_resp = requests.post(
    DROPBOX_DELETE_URL,
    headers=headers,
    json={"path": folder_path},
    timeout=30,
)
```

**Severity:** MEDIUM  
**Category:** Reliability

**Impact:**
- Parallel runs could create duplicate archives
- Folder deleted before archive completes
- Lost data if network interruption

**Remediation:**

Add atomic operations:
```python
import hashlib

def _dropbox_archive_folder(access_token: str, folder_path: str, archive_root: str) -> None:
    # Create unique archive name with content hash to detect duplicates
    folder_name = folder_path.split("/")[-1]
    temp_archive = f"{archive_root}/.tmp_{folder_name}_{uuid.uuid4().hex[:8]}.zip"
    final_archive = f"{archive_root}/{folder_name}.zip"
    
    try:
        # Download and upload to temp location
        zip_payload = _dropbox_download_zip(access_token, folder_path)
        _dropbox_upload_bytes(access_token, zip_payload, temp_archive)
        
        # Move to final location (atomic)
        requests.post(
            "https://api.dropboxapi.com/2/files/move_v2",
            headers={"Authorization": f"Bearer {access_token}"},
            json={"from_path": temp_archive, "to_path": final_archive, "autorename": False}
        )
        
        # Only delete after successful archive
        requests.post(DROPBOX_DELETE_URL, ...)
    except Exception:
        # Cleanup temp file on failure
        requests.post(DROPBOX_DELETE_URL, json={"path": temp_archive})
        raise
```

**Estimated Effort:** 4 hours

---

### ISSUE #14: Insufficient Test Coverage

**Location:** `tests/` directory

**Problem:**
Only 3 test files, many critical functions untested:

- `test_uk_air_sos_mock.py` - mocked SOS API tests
- `test_uk_air_sos_live.py` - live integration tests
- No tests for: `ingest_helpers.py`, coordinate swapping, Dropbox upload, error logging

**Severity:** MEDIUM  
**Category:** Code Quality / Reliability

**Impact:**
- Bugs not caught before deployment
- Risky refactoring
- Unknown edge case handling
- Harder to onboard new developers

**Recommended Tests:**

1. **Coordinate Handling:**
```python
@pytest.mark.parametrize("lon,lat,expected", [
    (51.5, -0.1, (-0.1, 51.5)),  # Swapped
    (-0.1, 51.5, (-0.1, 51.5)),  # Correct
    (None, 51.5, (None, 51.5)),  # Missing lon
    (-200, 51.5, (None, None)),  # Invalid range
])
def test_maybe_swap_coords(lon, lat, expected):
    result = maybe_swap_coords(lon, lat, UK_BBOX)
    assert result == expected
```

2. **Environment Variable Validation:**
```python
def test_missing_required_env_vars(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    with pytest.raises(SystemExit):
        validate_required_environment()
```

3. **Dropbox Token Refresh:**
```python
@responses.activate
def test_dropbox_token_refresh_retry_on_500():
    responses.add(responses.POST, DROPBOX_TOKEN_URL, status=500)
    responses.add(responses.POST, DROPBOX_TOKEN_URL, json={"access_token": "new_token"}, status=200)
    
    token = _dropbox_refresh_access_token(config)
    assert token == "new_token"
    assert len(responses.calls) == 2
```

**Estimated Effort:** 12-16 hours

---

### ISSUE #15: SQL Schema Has No Foreign Key Constraints on Some Relationships

**Location:** `supabase/uk_air_quality_schema.sql`

**Problem:**
Some relationships lack foreign key constraints:

```sql
-- Line 923-937: observations table
create table if not exists observations (
  timeseries_id bigint references timeseries(id) on delete cascade,  ✅ Has FK
  observed_at timestamptz not null,
  value numeric,
  status text,  -- ❌ Should reference status_codes table if standardized
  created_at timestamptz default now(),
  primary key (timeseries_id, observed_at)
);
```

**Severity:** MEDIUM  
**Category:** Data Integrity

**Impact:**
- Orphaned records possible
- Data inconsistency
- Harder to maintain referential integrity

**Remediation:**

Add missing constraints:
```sql
-- Create status codes lookup if not exists
create table if not exists observation_status_codes (
  code text primary key,
  description text,
  valid_for_connector_id bigint references connectors(id)
);

-- Add constraint to observations
alter table observations
  add constraint fk_status
  foreign key (status) references observation_status_codes(code)
  on delete restrict;

-- Consider adding index
create index if not exists observations_status_idx on observations(status);
```

**Estimated Effort:** 2 hours + migration planning

---

### ISSUE #16: No Request ID Correlation Across Logs

**Location:** All Python scripts and TypeScript functions

**Problem:**
Cannot correlate logs from single execution across files/systems.

**Severity:** MEDIUM  
**Category:** Observability

**Impact:**
- Hard to trace request flow
- Cannot correlate errors across services
- Difficult debugging in production

**Remediation:**

Add correlation ID:

Python:
```python
import uuid
import contextvars

request_id_var = contextvars.ContextVar('request_id', default=None)

def configure_logging_with_request_id():
    request_id = str(uuid.uuid4())
    request_id_var.set(request_id)
    
    class RequestIdFilter(logging.Filter):
        def filter(self, record):
            record.request_id = request_id_var.get() or 'no-request-id'
            return True
    
    for handler in logging.getLogger().handlers:
        handler.addFilter(RequestIdFilter())
```

TypeScript:
```typescript
const REQUEST_ID = crypto.randomUUID();

function log(level: string, message: string, context?: Record<string, unknown>) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    request_id: REQUEST_ID,
    ...context,
  }));
}
```

**Estimated Effort:** 4 hours

---

### ISSUE #17: Hardcoded Retry Limits Without Configuration

**Location:** Multiple files

**Problem:**
Retry counts hardcoded:

```python
# scripts/uk_air_sos_ingest.py:640
def __init__(
    self,
    base_url: str = UK_AIR_SOS_BASE_URL,
    timeout: int = 60,
    retries: int = 3,  # ❌ Hardcoded
    raw_recorder: Optional[RawPayloadRecorder] = None,
):
```

**Severity:** MEDIUM  
**Category:** Configuration

**Impact:**
- Cannot tune retry behavior without code changes
- Different environments need different settings
- Testing harder

**Remediation:**

Make configurable:
```python
DEFAULT_RETRIES = int(os.getenv("UK_AIR_SOS_RETRIES", "3"))
DEFAULT_TIMEOUT = int(os.getenv("UK_AIR_SOS_TIMEOUT", "60"))

def __init__(
    self,
    base_url: str = UK_AIR_SOS_BASE_URL,
    timeout: int = DEFAULT_TIMEOUT,
    retries: int = DEFAULT_RETRIES,
    raw_recorder: Optional[RawPayloadRecorder] = None,
):
```

**Estimated Effort:** 1 hour

---

### ISSUE #18: No Database Connection Pooling

**Location:** All Python scripts using Supabase

**Problem:**
New Supabase client created per script run:

```python
# scripts/uk_air_sos_ingest.py:843-847
def __init__(self) -> None:
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not supabase_key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")
    self.client: Client = create_client(supabase_url, supabase_key)  # ❌ No pooling
```

**Severity:** MEDIUM  
**Category:** Performance

**Impact:**
- Slower connections
- More database connections
- Resource waste

**Remediation:**

The Supabase Python client uses `httpx` which does connection pooling internally, so this is less critical. However, could optimize:

```python
from functools import lru_cache

@lru_cache(maxsize=1)
def get_supabase_client() -> Client:
    """Get cached Supabase client (singleton pattern)."""
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not supabase_key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")
    return create_client(supabase_url, supabase_key)

# Usage
self.client = get_supabase_client()
```

**Estimated Effort:** 1 hour

---

### ISSUE #19: Missing Monitoring/Alerting for Data Quality

**Location:** All ingestion scripts

**Problem:**
No automated checks for:
- Zero observations ingested
- Stale data (last_value_at too old)
- Missing stations
- Duplicate station detection

**Severity:** MEDIUM  
**Category:** Observability

**Impact:**
- Silent data quality degradation
- Users see stale/missing data
- Issues discovered late

**Remediation:**

Add data quality checks:
```python
def validate_data_quality(client: Client, connector_id: int) -> List[str]:
    """Run data quality checks and return list of issues."""
    issues = []
    
    # Check for stale data (no updates in 24h)
    resp = client.table("timeseries") \
        .select("count") \
        .eq("connector_id", connector_id) \
        .lt("last_value_at", (utcnow() - timedelta(hours=24)).isoformat()) \
        .execute()
    if resp.data and resp.data[0].get("count", 0) > 0:
        issues.append(f"Stale data: {resp.data[0]['count']} timeseries not updated in 24h")
    
    # Check for missing observations
    resp = client.rpc("uk_aq_timeseries_without_observations", {"connector_id_param": connector_id}).execute()
    if resp.data:
        issues.append(f"Missing observations: {len(resp.data)} timeseries have no data")
    
    return issues
```

**Estimated Effort:** 6 hours + monitoring setup

---

### ISSUE #20: Timestamp Parsing Has Multiple Fallback Paths

**Location:** `scripts/uk_air_sos_ingest.py:1943-1953`

**Problem:**
```python
def _parse_timestamp(raw: Any) -> Optional[datetime]:
    if raw is None:
        return None
    try:
        if isinstance(raw, (int, float)):
            return datetime.fromtimestamp(raw / 1000, tz=timezone.utc)
        if isinstance(raw, str):
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None
    return None
```

**Severity:** MEDIUM  
**Category:** Data Validation

**Impact:**
- Silent failures (returns None)
- Ambiguous timestamp formats
- No logging of parse failures

**Remediation:**

Add logging and stricter validation:
```python
def _parse_timestamp(raw: Any, context: str = "") -> Optional[datetime]:
    if raw is None:
        return None
    try:
        if isinstance(raw, (int, float)):
            # Detect milliseconds vs seconds
            if raw > 1e12:  # Likely milliseconds
                return datetime.fromtimestamp(raw / 1000, tz=timezone.utc)
            elif raw > 1e9:  # Likely seconds
                return datetime.fromtimestamp(raw, tz=timezone.utc)
            else:
                LOG.warning(f"Ambiguous timestamp value: {raw} {context}")
                return None
        if isinstance(raw, str):
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
        LOG.warning(f"Unexpected timestamp type: {type(raw)} {context}")
    except (ValueError, TypeError) as exc:
        LOG.warning(f"Timestamp parse failed: {raw} {context} - {exc}")
    return None
```

**Estimated Effort:** 2 hours

---

## 🔵 LOW SEVERITY ISSUES

### ISSUE #21: Inconsistent Naming: uk_aq vs uk_air vs ukair

**Location:** Throughout codebase

**Problem:**
Mixed naming conventions:
- `uk_air_sos_ingest.py` (file)
- `UK_AIR_SOS_BASE_URL` (env var)
- `uk_aq_latest` (edge function)
- `UKAIR_LIVE` (test env var)

**Severity:** LOW  
**Category:** Code Quality

**Impact:**
- Confusing for new developers
- Harder to search codebase
- Inconsistent branding

**Remediation:**

According to AGENTS.md:
> Prefer `uk_aq` in filenames, scripts, and docs (avoid `ukair`).

Rename files:
- `scripts/uk_air_sos_ingest.py` → `scripts/uk_aq_sos_ingest.py`
- `scripts/uk_air_sos_list_stations.py` → `scripts/uk_aq_sos_list_stations.py`

Update env vars:
- `UK_AIR_SOS_BASE_URL` → Keep (matches service name "UK-AIR SOS")
- `UKAIR_LIVE` → `UK_AQ_LIVE_TESTS`

**Estimated Effort:** 2 hours (find/replace + testing)

---

### ISSUE #22: No .gitignore Entry for *.log Files

**Location:** `.gitignore`

**Problem:**
Log files could be committed:
```
purpleair_fetch.log  (in root)
```

**Severity:** LOW  
**Category:** DevOps

**Impact:**
- Accidental log commits
- Repository bloat
- Potential sensitive data exposure

**Remediation:**

Add to `.gitignore`:
```
# Log files
*.log
error_logs/
```

**Estimated Effort:** 1 minute

---

### ISSUE #23: TODO/FIXME Comments Not Tracked

**Location:** Codebase (grep shows minimal TODOs)

**Problem:**
No systematic TODO tracking (good - none found!), but should have a process.

**Severity:** LOW  
**Category:** Process

**Remediation:**

Add to development guidelines:
```markdown
## TODO Management
- Use GitHub Issues for TODOs, not code comments
- Label issues with `tech-debt` for future improvements
- Reference issue numbers in comments: `// See issue #123`
```

**Estimated Effort:** 15 minutes (documentation)

---

### ISSUE #24: No Code Formatter Configuration

**Location:** Root directory

**Problem:**
No `pyproject.toml`, `.black.toml`, or `prettier.config.js` for consistent formatting.

**Severity:** LOW  
**Category:** Code Quality

**Impact:**
- Inconsistent code style
- Merge conflicts from formatting
- Manual style enforcement in PRs

**Remediation:**

Create `pyproject.toml`:
```toml
[tool.black]
line-length = 100
target-version = ['py310']
include = '\.pyi?$'
extend-exclude = '''
/(
  | archive
  | .venv
)/
'''

[tool.isort]
profile = "black"
line_length = 100
skip = ["archive", ".venv"]

[tool.pytest.ini_options]
testpaths = ["tests"]
python_files = "test_*.py"
python_classes = "Test*"
python_functions = "test_*"
```

Create `.prettierrc`:
```json
{
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "arrowParens": "always"
}
```

**Estimated Effort:** 1 hour (setup + initial format)

---

### ISSUE #25: Missing License File

**Location:** Root directory

**Problem:**
No `LICENSE` file in repository.

**Severity:** LOW  
**Category:** Legal / Compliance

**Impact:**
- Unclear usage rights
- Cannot contribute without license
- Potential legal issues

**Remediation:**

Add LICENSE file (recommend MIT or Apache 2.0 for open source projects):

```
MIT License

Copyright (c) 2025 [Organization Name]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction...
```

**Estimated Effort:** 5 minutes (after legal approval)

---

## Summary of Recommendations by Priority

### Immediate Actions (Next Sprint)
1. ✅ Fix hardcoded API key path (Issue #1)
2. ✅ Add environment variable validation (Issue #3)
3. ✅ Create requirements.txt (Issue #9)
4. ✅ Add .env.example (Issue #10)
5. ✅ Sanitize edge function inputs (Issue #4)

### Short Term (Next Month)
6. ✅ Enable TypeScript type checking (Issue #2)
7. ✅ Improve coordinate swap logic (Issue #5)
8. ✅ Add rate limiting (Issue #7)
9. ✅ Improve error context (Issue #8)
10. ✅ Add token caching/retry (Issue #6)

### Medium Term (Next Quarter)
11. ✅ Increase test coverage (Issue #14)
12. ✅ Add data quality monitoring (Issue #19)
13. ✅ Implement request ID correlation (Issue #16)
14. ✅ Add input validation schemas (Issue #12)
15. ✅ Standardize logging (Issue #11)

### Long Term (Ongoing)
16. ✅ Fix SQL schema constraints (Issue #15)
17. ✅ Resolve naming inconsistencies (Issue #21)
18. ✅ Add code formatters (Issue #24)
19. ✅ Document TODOs process (Issue #23)
20. ✅ Add LICENSE (Issue #25)

---

## Code Quality Metrics

### Test Coverage
- **Current:** ~20% (estimated)
- **Target:** 70%
- **Focus Areas:** `ingest_helpers.py`, coordinate validation, error logging

### Technical Debt
- **Estimated Days:** 25-30 days to address all issues
- **High Priority:** 10 days
- **Medium Priority:** 12 days
- **Low Priority:** 3-5 days

### Security Posture
- **Critical Vulnerabilities:** 2
- **High Risk Issues:** 7
- **Recommended:** Security audit before production deployment

---

## Appendix A: Files Reviewed

### Python Scripts (19)
- sensorcommunity_ingest.py
- uk_air_sos_ingest.py
- ingest_helpers.py
- uk_air_sos_list_stations.py
- sensorcommunity_list_stations.py
- uk_aq_backfill_timeseries_stations.py
- uk_aq_backfill_station_regions.py
- uk_aq_fix_station_geometry.py
- uk_aq_enrich_station_names.py
- uk_aq_enrich_station_names_report.py
- uk_aq_export_stations_dropbox.py
- uk_aq_load_pcon_boundaries.py
- uk_aq_load_la_boundaries.py
- uk_aq_load_guidelines.py
- uk_aq_error_log_archive.py
- uk_aq_dropbox_test.py
- get_uk_sensors.py
- uk_aq_defra_compare.py
- keepalive.mjs

### TypeScript Edge Functions (8)
- uk_aq_latest/index.ts
- uk_aq_timeseries/index.ts
- uk_aq_stations/index.ts
- uk_aq_la_hex/index.ts
- uk_aq_pcon_hex/index.ts
- uk_aq_bristol_latest/index.ts
- ingest_uk_air_sos/index.ts
- ingest_sensorcommunity/index.ts

### SQL Files (7)
- uk_air_quality_schema.sql
- uk_air_quality_views.sql
- purpleair_schema.sql
- data_checks.sql
- uk_aq_phenomena_pollutants.sql
- uk_aq_polling_cron.sql
- drop_uk_air_quality_tables.sql

### GitHub Actions (7)
- supabase_edge_deploy.yml
- uk_aq_stations_daily.yml
- uk_aq_raw_dropbox.yml
- uk_aq_pcon_refresh.yml
- uk_aq_dropbox_debug.yml
- supabase_keepalive.yml
- uk_aq_stations_test.yml

---

## Appendix B: Tools & Dependencies Audit

### Python Dependencies (requirements-dev.txt)
- `requests>=2.31.0` ✅ Up to date, secure
- `python-dotenv>=1.0.0` ✅ Standard, maintained
- `supabase>=2.0.0` ⚠️ Check for latest version
- `pytest>=7.4.0` ✅ Current
- `responses>=0.23.0` ✅ Current

### TypeScript/Deno
- Deno std@0.224.0 ⚠️ Check for updates
- No package.json for edge functions (Deno imports from URLs)

### Potential New Dependencies Recommended
- **Python:**
  - `black` (code formatter)
  - `isort` (import sorter)
  - `mypy` (type checker)
  - `ratelimit` (API rate limiting)
  - `structlog` (structured logging)
  
- **TypeScript:**
  - `zod` (schema validation)
  - Deno stdlib updates

---

## Appendix C: Security Checklist

- [x] No secrets in repository
- [x] Environment variables used for sensitive data
- [ ] Input validation on all user inputs (ISSUE #4, #12)
- [ ] SQL injection protection verified (ISSUE #4)
- [ ] Rate limiting on external APIs (ISSUE #7)
- [ ] Type safety enabled (ISSUE #2)
- [x] HTTPS for all external connections
- [ ] Error messages don't leak sensitive info (Generally OK)
- [ ] Logging doesn't include secrets (Generally OK)
- [x] Database uses RLS (Row Level Security)

---

**Review Completed:** 2026-01-15  
**Reviewer:** AI Code Review Agent  
**Next Review Recommended:** After addressing CRITICAL and HIGH severity issues
