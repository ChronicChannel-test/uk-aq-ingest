# Codex prompt: add IQAir connector to `uk-aq-ingest`

Work in this repo:
- `https://github.com/ChronicChannel-test/uk-aq-ingest`

## Goal

Add **IQAir** as a new **non-SOS connector** for UK air quality data, integrated into the existing ingest workflow and repo conventions.

The implementation must be **careful, minimal, and repo-shaped**. Do not invent a new architecture if existing connector patterns already cover most of what is needed.

## First: inspect the repo before changing anything

Before making edits, inspect the whole repo structure and identify the current patterns for:

- non-SOS connectors
- connector registration / metadata
- station upserts
- timeseries upserts
- observation upserts
- Cloud Run workers / entrypoints
- scripts folder conventions
- network docs and network info docs
- environment variable naming
- retry / logging / claim-run patterns

Especially inspect:

- `AGENTS.md`
- `scripts/`
- `workers/`
- `network_info/`
- `system_docs/`
- any existing non-SOS connector such as OpenAQ or similar

Use the repo’s existing style, naming, structure and helper functions wherever possible.

## External source to integrate

Use the current IQAir API docs as the source of truth:
- `https://api-docs.iqair.com/?version=latest`

Design for a **curated UK inventory approach**, not a full free-running discovery crawler.

## Product decision

Implement IQAir as:

- a **non-SOS connector**
- `connector_code = "iqair"`
- a **curated UK inventory** that is discovered once and then polled on a bounded schedule

Do **not** build a wide UK crawler that continuously rediscovers everything on every run.

## Functional requirements

Build the integration in phases, but in this task please scaffold the core pieces so the connector can be added cleanly.

### 1. Add IQAir network info docs

Create:

- `network_info/IQAir/README.md`

This should document:

- what IQAir is
- whether it is SOS or non-SOS
- expected auth method
- expected endpoints used
- known rate limits if documented
- the curated inventory strategy
- known open questions, especially around pollutant availability and historical access

Also create placeholder seed files if useful:

- `network_info/IQAir/iqair_uk_inventory_seed.json`
- `network_info/IQAir/iqair_field_mapping.csv`

Keep these small and well commented where possible.

### 2. Add IQAir system docs

Create:

- `system_docs/iqair.md`

Document:

- how this connector fits into the ingest system
- workflow overview
- key scripts
- env vars
- how to bootstrap inventory
- how to run ingest
- expected output entities in DB
- known limitations

### 3. Add IQAir scripts

Create a new folder:

- `scripts/iqair/`

Add these modules if they fit the repo style:

- `iqair_api.py`
- `iqair_discover_uk.py`
- `iqair_normalize.py`
- `iqair_ingest.py`

If the repo already has better naming conventions, use those instead.

#### `iqair_api.py`

Implement:

- base URL handling
- API key auth handling
- a reusable GET helper
- timeout handling
- retry / backoff for 429 and 5xx
- basic response validation
- lightweight rate-limit friendliness

Do not overengineer.

#### `iqair_discover_uk.py`

Implement a bootstrap discovery script that:

- lists UK states
- lists cities for those UK states
- optionally samples current city/station data
- writes a curated inventory seed JSON file

This script should be clearly marked as a **bootstrap/manual refresh** tool, not the normal hourly ingest path.

If the API docs or the actual payload shape are ambiguous, code defensively and leave TODO comments only where necessary.

#### `iqair_normalize.py`

Implement normalization helpers that map IQAir payloads into the project’s internal model.

Aim for:

- stable `station_ref`
- deterministic fallback ID if IQAir does not provide a stable station ID
- normalized pollutant names
- normalized timestamps in UTC
- normalized coordinates
- normalized timeseries refs

Support AQI-only payloads gracefully. If only AQI is available, do not pretend it is a pollutant concentration.

#### `iqair_ingest.py`

Implement the main ingest flow:

- read curated UK inventory
- fetch current data for each active inventory item
- normalize results
- upsert stations / timeseries / observations using existing repo helpers and patterns
- log counts and failures in the same style as existing scripts

The ingest path must:

- skip broken inventory entries without killing the full run
- be idempotent where possible
- avoid duplicate observations
- be safe if only partial data is available

### 4. Add worker scaffold if appropriate

Inspect the repo and determine whether IQAir should have its own worker under `workers/`, or whether it should be run through an existing shared mechanism.

If the repo convention is one worker per connector, create:

- `workers/uk_aq_iqair_cloud_run/`

with the repo-standard files such as:

- `README.md`
- `Dockerfile`
- `service_entrypoint.py`

Reuse the current worker conventions for:

- claiming work
- env var loading
- script invocation
- logging
- run recording

If a separate worker is **not** needed based on existing patterns, explain why in your final notes instead of creating one.

### 5. Register the connector in the existing ingest model

Find how connectors are currently registered and add IQAir in the correct place.

Set sensible defaults such as:

- service ref: `iqair`
- display name: `IQAir`
- label: `IQAir`
- connector type: non-SOS

Do not add IQAir into any SOS-only structures.

### 6. Environment variables

Add only the minimum required environment variables and document them.

Likely:

- `IQAIR_API_KEY`

If the repo uses a prefix convention for secrets, follow that convention.

Do not introduce multiple env vars unless genuinely needed.

### 7. Implementation constraints

- Keep the implementation **small and composable**.
- Prefer existing helper utilities over new abstractions.
- Follow the repo’s current formatting, logging and error-handling style.
- Do not add speculative historical backfill support unless the repo and API clearly support it.
- Do not hardcode a giant inventory into code.
- Do not build a scheduler inside Python if the repo already uses workers / Cloud Run / external scheduling.
- Do not guess DB schema details if helper functions already abstract them.

## Behavioural expectations

The connector should be built around this strategy:

1. Bootstrap UK inventory separately.
2. Store curated inventory in a seed file and/or whatever existing reference mechanism the repo already uses.
3. Hourly ingest reads only the curated active inventory.
4. Normalize and upsert observations into the existing DB model.

## Open questions to handle carefully

Where facts are unclear from the docs, inspect existing code and make conservative choices.

Examples:

- whether IQAir returns city-level only or station-level data for the plan used
- whether pollutant concentrations are present or only AQI
- exact station identity fields
- whether timestamps are local or UTC

Where needed:

- code defensively
- preserve raw fields in comments or mapping docs
- note assumptions in docs
- avoid fake certainty

## Deliverables

Please make the code changes directly in the repo and then provide:

1. a summary of files added/changed
2. any assumptions made about the IQAir payload
3. anything still blocked on having a real API key
4. exact commands to:
   - run UK inventory bootstrap
   - run IQAir ingest locally
   - run or deploy the worker if created

## Nice to have

If easy and consistent with existing patterns, also add:

- a tiny sample inventory file with 1 to 3 placeholder UK entries or commented examples
- a dry-run mode for `iqair_ingest.py`
- unit-testable pure normalization helpers

## Very important

Before editing, inspect existing comparable connectors and mirror them closely.

The goal is not just “make IQAir work”, but “make IQAir look like it belongs in this repo”.
