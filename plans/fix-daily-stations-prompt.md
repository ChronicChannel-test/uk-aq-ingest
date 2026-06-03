Please analyse and fix the daily stations workflow failure.

Context:

The GitHub Actions workflow uk_aq_stations_daily.yml failed on 2026-06-03 during the step:

bash python3 scripts/stations_daily/sync_obs_aqidb_uk_aq_core.py 

Earlier station steps completed successfully, including:

- Breathe London station metadata upsert
- OpenAQ stations sync was skipped intentionally
- R2 geo refresh completed
- station_name check found 0 missing
- Dropbox station export completed

The failure happened during the obs_aqidb sync step.

The traceback shows the failure was in:

text scripts/stations_daily/sync_obs_aqidb_uk_aq_core.py 

Specifically:

text main()   source_rows = src_client.fetch_all_rows(...)  fetch_all_rows()   batch = self.request_json("GET", f"/rest/v1/{table}", ...)  request_json()   response = requests.request(...) 

The failed request was:

text GET https://zztjgmdiftqtdcrlfpvc.supabase.co/rest/v1/stations?select=*&limit=1000&offset=4000&order=id.asc 

The exception was:

text requests.exceptions.SSLError: HTTPSConnectionPool(host='zztjgmdiftqtdcrlfpvc.supabase.co', port=443): Max retries exceeded with url: /rest/v1/stations?select=*&limit=1000&offset=4000&order=id.asc  Caused by: ssl.SSLEOFError: [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol 

This looks like a transient Supabase/API/network SSL EOF failure rather than a station sync logic failure.

Goal:

Make the daily stations sync resilient to transient Supabase/API/network failures, especially:

- requests.exceptions.SSLError
- requests.exceptions.ConnectionError
- requests.exceptions.Timeout
- HTTP 429
- HTTP 500
- HTTP 502
- HTTP 503
- HTTP 504

Do not hide real persistent failures. The workflow should still fail after retries are exhausted.

Tasks:

1. Inspect .github/workflows/uk_aq_stations_daily.yml

   - Confirm the workflow step that runs scripts/stations_daily/sync_obs_aqidb_uk_aq_core.py.
   - Check whether the workflow has a suitable overall timeout-minutes.
   - If there is no job timeout, add a sensible timeout-minutes, but do not make it excessive.
   - Do not make the sync step continue-on-error.
   - Keep daily task health reporting working so failures still get reported properly.

2. Inspect scripts/stations_daily/sync_obs_aqidb_uk_aq_core.py

   - Find the Supabase REST client class and its request_json and fetch_all_rows methods.
   - Add robust retry handling around individual REST requests.
   - Retries should apply only to transient network errors and retryable HTTP statuses.
   - Use exponential backoff with jitter.
   - Default retry policy should be conservative, for example:
     - max attempts: 5
     - initial delay: 1 second
     - multiplier: 2
     - maximum sleep: 30 seconds
   - These values can be constants or environment-variable configurable, but defaults must work without any new secrets.

3. The retry wrapper should:

   - Log the method, table/path, status code if available, attempt number, max attempts, and sleep seconds.
   - Never log Supabase service role keys or auth headers.
   - Preserve existing behaviour for non-retryable 4xx responses.
   - Raise a clear final exception after retries are exhausted.

4. Improve pagination resilience:

   - In fetch_all_rows, make sure each page request can be retried independently.
   - If a page fails transiently, retry that same page rather than restarting the whole table sync.
   - Keep ordering deterministic, using the existing order=id.asc or equivalent.
   - Do not skip pages silently.
   - Do not change sync semantics unless needed.

5. Consider whether page size should be reduced:

   - The failing request used limit=1000&offset=4000.
   - Check whether the script has a fixed page size.
   - If page size is configurable, leave it unless there is a good reason to change.
   - If reducing from 1000 to 500 would materially improve reliability, make it configurable via environment variable and default to the existing value unless tests show a need to change.
   - Do not make a performance-only change without explaining it in comments or the final summary.

6. Add tests where practical:

   - Add or update unit tests for the request retry logic.
   - Mock requests.request so tests cover:
     - one transient SSLError followed by success
     - one Timeout followed by success
     - HTTP 503 followed by success
     - non-retryable HTTP 400 fails immediately
     - retries exhausted raises an error
   - Add a test that fetch_all_rows retries a failed middle page and continues correctly.

7. Run relevant tests and checks.

   At minimum, run:

bash python3 -m py_compile scripts/stations_daily/sync_obs_aqidb_uk_aq_core.py 

   Also run any existing Python tests for scripts/stations_daily.

   If there is no existing test suite, add a small focused test file and document how to run it.

8. Output a concise summary of:

   - Root cause found
   - Files changed
   - Retry behaviour added
   - Tests added or updated
   - Commands run
   - Any follow-up recommendations

Important constraints:

- Do not archive files.
- Do not remove daily task health reporting.
- Do not make the failed sync step optional.
- Do not mask failures by returning success when sync has not completed.
- Do not log secrets.
- Keep the workflow suitable for GitHub Actions.
- Keep changes targeted to the daily stations sync resilience issue.