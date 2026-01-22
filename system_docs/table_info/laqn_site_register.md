# laqn_site_register

Snapshot of LAQN site listings for matching and membership backfills.

## Fields
- id: Internal primary key.
- site_ref: LAQN site code (source identifier).
- label: Raw source label string.
- station_name: Optional cleaned station name.
- station_type: Source station classification.
- station_exposure: Source station exposure.
- local_authority: Local authority or borough when available.
- network_label: Raw network flag from the source (e.g., LAQN, AURN, mixed).
- networks: Normalized network tags when known.
- latitude: Site latitude.
- longitude: Site longitude.
- lat_offset: Map offset latitude (LondonAir list).
- lon_offset: Map offset longitude (LondonAir list).
- site_url: Source link to the site details.
- first_seen_at: First seen date from source.
- last_seen_at: Last seen date from source.
- removed_at: Removal/closure date from source.
- source_url: URL used to fetch the snapshot.
- source_file: Local or Dropbox filename for the snapshot.
- snapshot_at: Snapshot timestamp.
- raw_payload: Raw source record JSON.
- created_at: Row creation timestamp.

## Notes
- Use `site_ref` as the LAQN source identifier.
- Store normalized network labels in `networks` (e.g., `LAQN`, `AURN`) and keep the raw value in `network_label`.
