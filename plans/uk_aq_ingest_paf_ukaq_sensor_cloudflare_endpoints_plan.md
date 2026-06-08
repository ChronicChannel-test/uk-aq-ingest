# UK-AQ Ingest Cloudflare Endpoint Plan for PurpleAirFriend and UK-AQ Sensor Networks

Draft date: 2026-06-08

## Purpose

Add Cloudflare-backed ingest, device config and device update endpoints to the existing `uk-aq-ingest` repository for two UK-AQ device networks:

```text
purpleairfriend
ukaq
```

These endpoints should support:

1. PurpleAirFriend devices that forward local PurpleAir readings.
2. UK-AQ-built Pico sensors that measure PM, temperature, humidity and pressure directly.

The endpoint implementation should live in `uk-aq-ingest`, not in the new `uk-aq-device-software` repo.

## Main decision

Cloudflare endpoint code belongs in the existing `uk-aq-ingest` repo because it is backend ingest infrastructure.

Device-side code belongs in the new `uk-aq-device-software` repo.

## Networks / connector codes

### 1. `purpleairfriend`

Purpose:

- Receives readings forwarded from a local PurpleAir monitor.
- Forwarder may be a Pico 2 W PAF box or an owner-computer PAF app.
- The forwarder is not the air quality sensor itself.
- The source sensor is a PurpleAir monitor on the same LAN as the forwarder.

Default behaviour:

- Device polls local PurpleAir URL such as `http://192.168.x.x/json`.
- Device polls every 120 seconds by default.
- Device uploads a batch every 600 seconds by default.
- Device sends all collected 2-minute readings, not just a 10-minute average.
- Payload should include raw PurpleAir JSON plus selected normalised fields.

### 2. `ukaq`

Purpose:

- Receives readings from UK-AQ-built sensors.
- First target is Pico 2 WH with PMSA003 particulate sensor and Adafruit BME280 temperature/humidity/pressure sensor.
- This is not PAF and must not be labelled as PAF.

Default behaviour:

- Device reads PMSA003 and BME280 directly.
- Device uploads readings to the UK-AQ Cloudflare endpoint.
- Payload should include direct PM readings plus environmental readings.

## Proposed Cloudflare endpoints

Use separate ingest routes for clarity:

```text
POST /purpleairfriend/v1/readings
POST /ukaq-sensor/v1/readings
```

Use shared routes for device config and update checks:

```text
GET /device/v1/config
GET /pico/v1/update-manifest
GET /pico/v1/release-file/:app/:version/:filename
POST /device/v1/health
```

The exact route prefixes may be adjusted to match the existing `uk-aq-ingest` Worker routing conventions.

## Shared request headers

All device calls should use:

```text
X-UKAQ-Device-Uid
X-UKAQ-Device-Token
X-UKAQ-App
X-UKAQ-Version
X-UKAQ-Hardware
```

Example app names:

```text
paf-pico
paf-computer
ukaq-sensor-pico
```

Example hardware values:

```text
pico-2-w
pico-2-wh
macos
linux
```

## Security model

For v1, use simple per-device tokens.

Rules:

- Each device has a unique `DEVICE_UID`.
- Each device has a unique `UKAQ_DEVICE_TOKEN`.
- Tokens can be revoked independently.
- User devices must never contain Supabase service-role keys.
- User devices must never contain Dropbox credentials.
- User devices must never contain Cloudflare account tokens.
- User devices must never contain GitHub tokens.
- Devices upload only to Cloudflare endpoints.
- Cloudflare handles archive/normalisation/backend writes.

Later improvements can add signed requests or rotating tokens, but v1 should remain simple.

## Cloud-side flow

Expected flow for both networks:

```text
device
  -> Cloudflare Worker ingest endpoint
      -> validate device token
      -> validate payload schema
      -> write raw payload archive to R2
      -> normalise selected observations
      -> write to Supabase via RPC or existing ingest path
      -> trigger/update latest snapshot outbox as appropriate
      -> return accepted/rejected response
```

## R2 raw archive

Archive raw incoming payloads before or alongside normalisation.

Suggested R2 key pattern:

```text
raw/device-ingest/{connector_code}/YYYY/MM/DD/{device_uid}/{request_id}.json
```

Examples:

```text
raw/device-ingest/purpleairfriend/2026/06/08/PAF-0001/01JXYZ.json
raw/device-ingest/ukaq/2026/06/08/UKAQ-0001/01JXYZ.json
```

The exact object-key format can be adjusted to match existing UK-AQ R2 conventions.

## PurpleAirFriend payload shape

Recommended high-level payload:

```json
{
  "connector_code": "purpleairfriend",
  "device_uid": "PAF-0001",
  "site_uid": "friend-example-001",
  "source": {
    "type": "purpleair_local_json",
    "purpleair_url": "http://192.168.x.x/json",
    "purpleair_sensor_id": "example"
  },
  "app": {
    "name": "paf-pico",
    "version": "0.1.0",
    "hardware": "pico-2-w"
  },
  "readings": [
    {
      "sampled_at_utc": "2026-06-08T10:00:00Z",
      "received_from_sensor_at_utc": null,
      "normalised": {
        "pm1_0_atm": 4.1,
        "pm1_0_atm_b": 4.2,
        "pm2_5_atm": 8.4,
        "pm2_5_atm_b": 8.9,
        "pm10_0_atm": 11.2,
        "pm10_0_atm_b": 11.8,
        "temperature_f": 68,
        "relative_humidity_percent": 63,
        "pressure_hpa": 1013.2,
        "rssi": -55
      },
      "raw": {
        "example": "full PurpleAir /json payload here"
      }
    }
  ]
}
```

The `raw` value should contain the PurpleAir `/json` payload returned by the local sensor. The `normalised` value should contain the fields UK-AQ wants to index directly.

## UK-AQ sensor payload shape

Recommended high-level payload:

```json
{
  "connector_code": "ukaq",
  "device_uid": "UKAQ-0001",
  "site_uid": "ukaq-test-001",
  "source": {
    "type": "ukaq_pico_sensor",
    "pm_sensor": "PMSA003",
    "environment_sensor": "Adafruit BME280"
  },
  "app": {
    "name": "ukaq-sensor-pico",
    "version": "0.1.0",
    "hardware": "pico-2-wh"
  },
  "readings": [
    {
      "sampled_at_utc": "2026-06-08T10:00:00Z",
      "normalised": {
        "pm1_0_atm": 4.1,
        "pm2_5_atm": 8.4,
        "pm10_0_atm": 11.2,
        "temperature_c": 18.5,
        "relative_humidity_percent": 63,
        "pressure_hpa": 1013.2
      },
      "raw": {
        "pmsa003": {},
        "bme280": {}
      }
    }
  ]
}
```

## Device config endpoint

Recommended endpoint:

```text
GET /device/v1/config
```

Inputs:

```text
X-UKAQ-Device-Uid
X-UKAQ-Device-Token
X-UKAQ-App
X-UKAQ-Version
X-UKAQ-Hardware
```

Returns app/device configuration, for example:

```json
{
  "device_uid": "PAF-0001",
  "enabled": true,
  "site_uid": "friend-example-001",
  "connector_code": "purpleairfriend",
  "poll_seconds": 120,
  "upload_seconds": 600,
  "purpleair_url": "http://192.168.x.x/json",
  "check_config_after_seconds": 86400,
  "check_update_after_seconds": 86400
}
```

For `ukaq-sensor-pico`, it should return sensor-specific config such as sampling cadence and upload cadence.

## Pico update endpoint

Recommended endpoint:

```text
GET /pico/v1/update-manifest
```

Purpose:

- Used by Pico apps, including `paf-pico` and `ukaq-sensor-pico`.
- Supports app/config updates over Wi-Fi.
- Recovery remains BOOTSEL/UF2.
- Details should align with `ukaq_pico_app_ota_update_plan.md`.

Example no-update response:

```json
{
  "update_available": false,
  "server_time_utc": "2026-06-08T10:00:00Z",
  "check_after_seconds": 86400
}
```

Example update response:

```json
{
  "update_available": true,
  "app": "paf-pico",
  "target_version": "0.1.1",
  "min_current_version": "0.1.0",
  "files": [
    {
      "path": "app_current.py",
      "url": "https://<worker>/pico/v1/release-file/paf-pico/0.1.1/app_current.py",
      "sha256": "<sha256>",
      "size_bytes": 12345
    }
  ],
  "check_after_seconds": 86400
}
```

Release files should be stored privately in R2 and served through the Worker after token validation.

## Suggested Cloudflare storage

Use R2 for:

```text
raw payload archive
Pico release files
release manifests, if preferred
```

Use KV or D1 for:

```text
device_uid -> token hash / status / site_uid / app policy
device_uid -> target version / config override
```

For v1, KV is likely enough for device config and update policy. If relational querying or admin screens become important, D1 or Supabase-backed lookup can be added later.

## Validation rules

Both ingest endpoints should:

- Require device UID and token headers.
- Reject disabled or unknown devices.
- Check `connector_code` matches endpoint.
- Check `device_uid` in body matches header.
- Validate `readings` is a non-empty array.
- Limit batch size.
- Limit payload size.
- Validate timestamps.
- Accept raw payloads but only normalise known fields.
- Return structured errors without leaking secrets.

## Open implementation details

These can be resolved during implementation:

- Exact Worker routing style in existing `uk-aq-ingest`.
- Exact Supabase RPC name for device ingest.
- Exact R2 binding name.
- Exact KV/D1 binding name.
- Whether token values are stored hashed in KV/D1 or checked via existing secrets/admin table.
- Exact payload-size limit.
- Exact batch-size limit.
- Exact latest snapshot trigger/outbox integration.

## Codex prompt to implement in `uk-aq-ingest`

```text
You are working in the existing uk-aq-ingest repository.

Goal:
Implement Cloudflare Worker support for two UK-AQ device networks:
1. purpleairfriend: PurpleAirFriend forwarders that send local PurpleAir readings.
2. ukaq: UK-AQ-built sensors, starting with Pico 2 WH + PMSA003 + Adafruit BME280.

Important architecture decisions:
- Cloudflare endpoint implementation belongs in uk-aq-ingest.
- Device-side code belongs in a separate repo called uk-aq-device-software and should not be implemented here.
- PAF is only a PurpleAir forwarder and must use connector code purpleairfriend.
- UK-AQ-built sensors must use connector code ukaq and must not be called PAF.
- Devices must never contain Supabase service-role keys, Dropbox credentials, Cloudflare account tokens or GitHub tokens.
- Devices upload only to Cloudflare. Cloudflare handles validation, raw archive, normalisation and backend writes.

Please first inspect the current repository structure and existing Cloudflare Worker patterns. Reuse the repo’s existing conventions for routing, environment variables, R2 bindings, Supabase calls, logging, tests and deployment. Do not invent a conflicting structure if one already exists.

Implement or scaffold these routes, using the repo’s existing Worker routing conventions:

POST /purpleairfriend/v1/readings
POST /ukaq-sensor/v1/readings
GET /device/v1/config
GET /pico/v1/update-manifest
GET /pico/v1/release-file/:app/:version/:filename
POST /device/v1/health

Shared auth headers:

X-UKAQ-Device-Uid
X-UKAQ-Device-Token
X-UKAQ-App
X-UKAQ-Version
X-UKAQ-Hardware

v1 auth model:
- Per-device tokens.
- Unknown or disabled devices are rejected.
- Token validation should be isolated behind a helper so the storage backend can change later.
- If there is no existing device-token store, scaffold a simple KV-backed implementation with clear TODOs and safe defaults.
- Do not log tokens.

Ingest behaviour:
- Validate headers.
- Parse JSON body.
- Require body.device_uid to match X-UKAQ-Device-Uid.
- Require connector_code to match the endpoint:
  - /purpleairfriend/v1/readings expects purpleairfriend.
  - /ukaq-sensor/v1/readings expects ukaq.
- Validate readings is a non-empty array.
- Enforce a sensible maximum payload size and batch size.
- Archive the raw request payload to R2 using a connector/date/device/request-id object key.
- Normalise selected fields into an internal observation structure.
- Call the existing Supabase/RPC ingest path if one exists. If the exact RPC is not yet available, scaffold a clearly named helper with TODOs and tests around input validation/archive behaviour.
- Return structured JSON responses.

Suggested R2 raw archive key pattern:
raw/device-ingest/{connector_code}/YYYY/MM/DD/{device_uid}/{request_id}.json

PurpleAirFriend payload:
- connector_code: purpleairfriend
- device_uid
- site_uid
- source.type: purpleair_local_json
- source.purpleair_url
- app.name, app.version, app.hardware
- readings[] with sampled_at_utc, normalised fields and raw PurpleAir /json payload
- Normalised fields may include pm1_0_atm, pm1_0_atm_b, pm2_5_atm, pm2_5_atm_b, pm10_0_atm, pm10_0_atm_b, temperature_f, relative_humidity_percent, pressure_hpa, rssi.

UK-AQ sensor payload:
- connector_code: ukaq
- device_uid
- site_uid
- source.type: ukaq_pico_sensor
- source.pm_sensor: PMSA003
- source.environment_sensor: Adafruit BME280
- app.name, app.version, app.hardware
- readings[] with sampled_at_utc, normalised fields and optional raw sensor data
- Normalised fields may include pm1_0_atm, pm2_5_atm, pm10_0_atm, temperature_c, relative_humidity_percent, pressure_hpa.

Device config route:
- GET /device/v1/config returns per-device config after token validation.
- It should support PAF config fields such as poll_seconds, upload_seconds and purpleair_url.
- It should support UK-AQ sensor config fields such as sample_seconds and upload_seconds.
- If no device-specific config store exists yet, scaffold a KV-backed helper and return safe default config for known test devices only.

Pico update route:
- GET /pico/v1/update-manifest returns no-update or update-available responses.
- Release files should be private in R2 and served through /pico/v1/release-file/:app/:version/:filename after token validation.
- This is for app/config updates. BOOTSEL/UF2 remains the recovery route.
- Align naming with ukaq_pico_app_ota_update_plan.md if that file exists in the repo or docs.

Health route:
- POST /device/v1/health accepts status reports such as app version, hardware, uptime, last upload success, queue depth and error summaries.
- Do not require this to write to Supabase unless a suitable existing table/path exists. Scaffolding/logging is acceptable for v1.

Testing:
- Add tests for auth rejection, missing headers, wrong connector code, device_uid mismatch, empty readings, valid PurpleAirFriend batch, valid UK-AQ sensor batch, R2 key generation and no-token logging.
- Add example payload fixtures for both connector codes.
- Add README/docs describing the endpoints, headers, expected payloads, storage bindings and local test commands.

Safety:
- Do not include real tokens, Supabase keys or Cloudflare credentials in code, tests or docs.
- Use placeholder values only.
- Avoid broad public R2 access. R2 release files should be served through the Worker after device auth.

Before making changes:
- Inspect existing files and summarise the repo conventions you found.
- Identify exactly which files you will create or modify.
- If there are ambiguous choices, choose the smallest safe scaffold and leave clear TODO comments.
```
