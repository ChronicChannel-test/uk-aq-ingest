# Sensor.Community API reference (for air-quality mapping)

This page is a practical reference for **Sensor.Community** (formerly Luftdaten) data access and ingestion, with an emphasis on **PM2.5/PM10** mapping and long-term archiving.

---

## 1) Which domain to use

Sensor.Community uses two main domains:

- **Read data (recommended):** `data.sensor.community`
- **Push data (for sensor owners):** `api.sensor.community`

Sensor.Community explicitly recommends using **`data.sensor.community`** for serving data to clients because it is faster and more reliable for requests.

---

## 2) Data freshness and update cadence

Sensor.Community notes that data is not always immediate for performance reasons:

- **Near-real-time feeds** update about **every minute**
- **24-hour averaged feeds** update about **every 5 minutes**

For map displays, you will normally use either:
- last 5 minutes (best for “right now”)
- last 1 hour (more stable)
- last 24 hours (stable, good for coverage analysis)

---

## 3) Read APIs (no auth)

### 3.1 V1 raw “recent measurements” (last 5 minutes)

#### Global last-5-minute dump (large)
- `https://data.sensor.community/static/v1/data.json`

Use this only if you really need “everything” and you can cache aggressively. For a city map, prefer filtering.

#### Filter endpoint (recommended for city maps)
- `https://data.sensor.community/airrohr/v1/filter/{query}`

Supported filters (examples):
- **Radius search:**  
  `https://data.sensor.community/airrohr/v1/filter/area=51.4545,-2.5879,10`  
  (lat, lon, distance in km)
- **Bounding box:**  
  `https://data.sensor.community/airrohr/v1/filter/box=51.38,-2.72,51.52,-2.45`  
  (lat1, lon1, lat2, lon2)
- **Country:**  
  `https://data.sensor.community/airrohr/v1/filter/country=GB`
- **Sensor type:**  
  `https://data.sensor.community/airrohr/v1/filter/type=SDS011,BME280`

You can combine filters by putting them into a single query string segment, for example:  
`.../filter/box=...&type=SDS011`

#### One sensor’s last-5-minute data
- `https://data.sensor.community/airrohr/v1/sensor/{apiID}/`

Important: `{apiID}` here refers to the ID used by the map/API, not the chip ID you might see on the device.

---

### 3.2 V2 per-sensor averages (often best for maps)

V2 endpoints are “one row per sensor” style, already averaged over a window:

- Last 5 minutes average per sensor:  
  `https://data.sensor.community/static/v2/data.json`
- Last 1 hour average per sensor:  
  `https://data.sensor.community/static/v2/data.1h.json`
- Last 24 hours average per sensor:  
  `https://data.sensor.community/static/v2/data.24h.json`

Also available:
- Dust sensors only (PM):  
  `https://data.sensor.community/static/v2/data.dust.min.json`
- Temperature/pressure sensors only:  
  `https://data.sensor.community/static/v2/data.temp.min.json`

V2 is usually better for:
- coverage counting (how many sensors in an area)
- “latest per sensor” map layers
- reducing the amount of time-series processing you do in your app

---

## 4) Headers and good citizenship

Sensor.Community asks API clients to send a **User-Agent** header, ideally identifying your project, so they can contact you if your requests are excessive.

Example:
```bash
curl -H "User-Agent: yourprojectname (contact: you@example.com)" \
  "https://data.sensor.community/airrohr/v1/filter/box=51.38,-2.72,51.52,-2.45"
```

Practical tips:
- Cache responses for at least **60 seconds** (often 120 to 300 seconds is fine).
- Prefer **box** or **area** filters over global dumps.
- Use a backoff strategy if you receive HTTP 429 or transient errors.

---

## 5) Sensor IDs and what to store

There are two “ID worlds”:

### 5.1 Map/API IDs (used for reading)
- Used by `.../sensor/{apiID}/`
- Obtainable by clicking a sensor on the Sensor.Community map and observing the ID.

### 5.2 Device IDs (used for submitting)
- Used in the `X-Sensor` header when pushing data.
- Often looks like `esp8266-12345678` for NodeMCU-based sensors.

Recommendation for your database:
- Store both if you can.
- Treat the **API ID** as the primary read key for pull-based ingestion.
- Keep a separate `source_id` or `device_id` column if present.

---

## 6) Value types for particulate matter

For PM values in pushed data (and commonly in retrieved data), Sensor.Community uses:
- `P1` for **PM10**
- `P2` for **PM2.5**

Common particulate sensor hardware includes SDS011 and PMS-series sensors (PMS1003, PMS7003, etc.).

---

## 7) Posting data (for sensor owners)

If you ever publish your own sensors into Sensor.Community, the push endpoint is:

- `https://api.sensor.community/v1/push-sensor-data/`

Typical request requirements:
- Headers:
  - `Content-Type: application/json`
  - `X-Pin: <pin number>`
  - `X-Sensor: <device id>`
- JSON body includes:
  - `software_version`
  - `sensordatavalues` array of `{value_type, value}`

Sensor.Community notes you should not send your own timestamp. The server sets it.

---

## 8) Historical archives (public sensors)

Sensor.Community provides historical exports via:

- **Daily archive:** `https://archive.sensor.community/`
  - Organised by date folders, typically with gzipped CSV files.
- **Monthly archive:** `https://archive.sensor.community/csv_per_month/`
  - Organised by `YYYY-MM` folders.

A typical daily file name pattern looks like:
- `{YYYY-MM-DD}_ppd42ns_sensor_{id}.csv.gz`

Timestamp note:
- Archived timestamps are generally treated as **UTC**.

Recommended use:
- Use archives to build a reproducible “raw lake” of historical data.
- Partition by date and keep checksums in a manifest table.

---

## 9) Recommended polling strategy for a city map

### 9.1 For the live map layer
- Use V2 if possible:
  - `static/v2/data.1h.json` for stable map colouring
  - `static/v2/data.json` for “right now”
- Filter to your region:
  - If you use V1 filter endpoints, prefer `box=` or `area=`.
  - If you use V2 global dumps, you must spatial-filter client-side, and you should cache heavily.

Suggested poll intervals:
- Every **5 minutes** for the live map
- Cache responses for 60 to 300 seconds

### 9.2 For your long-term archive
- Do not store every raw pull in Postgres.
- Store raw snapshots in object storage (R2/S3) as daily or hourly partitions.
- Store aggregates in Supabase (hourly for 30 to 90 days, daily forever).

---

## 10) Minimal data model (fits Supabase well)

Recommended tables:

### `stations`
- `id` (bigint or uuid, internal)
- `provider` = `sensorcommunity`
- `provider_station_id` (text, unique with provider)
- `name` (text)
- `lat`, `lon` (numeric)
- `geometry` (PostGIS point)
- `last_seen_at` (timestamptz)

Unique constraint:
- `(provider, provider_station_id)`

### `latest_readings`
- `station_id` (FK)
- `pollutant` (text, eg `pm25`)
- `observed_at` (timestamptz)
- `value` (double precision)

Primary key:
- `(station_id, pollutant)`

### `agg_hourly` and `agg_daily`
- keys: `(station_id, pollutant, bucket_start)`
- fields: mean, max, min, count, data_capture_pct (optional)

---

## 11) Common pitfalls

- Confusing the **API/map sensor ID** with the **device ID**.
- Over-polling global endpoints without caching.
- Treating community sensors as reference-grade. For public health framing, use clear labelling and consider cross-checks against reference stations where possible.
- Indoor sensors. If you need outdoor-only views, filter by whatever “location” or “indoor/outdoor” indicators are present in the feed you choose.

---

## 12) Useful links

- Sensor.Community API wiki (read and push docs):  
  `https://github.com/opendata-stuttgart/meta/wiki/APIs`
- Sensor.Community archive root:  
  `https://archive.sensor.community/`
- Monthly archive:  
  `https://archive.sensor.community/csv_per_month/`
- Data-serving domain:  
  `https://data.sensor.community/`

