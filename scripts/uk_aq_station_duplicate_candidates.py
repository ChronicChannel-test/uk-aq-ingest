#!/usr/bin/env python3
"""Build possible duplicate station candidates from spatial match CSVs.

Default flow:
1) Read `plans/json_aurn_within_30m_all_matches.csv` (distance-based matches).
2) Read `plans/gov_uk_aurn_site_register_*.csv` (AURN register metadata).
3) Keep `aurn-json` rows within a distance threshold.
4) Extract pollutant text from JSON-side labels and compare with AURN pollutant list.
5) Write:
   - row-level candidate CSV
   - station-pair summary CSV
"""

from __future__ import annotations

import argparse
import csv
import difflib
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

DEFAULT_MATCHES_CSV = Path("plans/json_aurn_within_30m_all_matches.csv")
DEFAULT_AURN_REGISTER_CSV = Path("plans/gov_uk_aurn_site_register_20260117T154937Z.csv")
DEFAULT_OUTPUT_ROWS_CSV = Path("plans/uk_aq_station_duplicate_candidates_rows.csv")
DEFAULT_OUTPUT_STATIONS_CSV = Path("plans/uk_aq_station_duplicate_candidates_stations.csv")

POLLUTANT_PARENS_RE = re.compile(r"\([^)]*\)")
NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
SIMPLE_SPLIT_RE = re.compile(r"\s*[;|]\s*")

CANONICAL_POLLUTANT_PATTERNS: Sequence[Tuple[re.Pattern[str], str]] = (
    (re.compile(r"\bpm[\s\-]?2[.,]?\s*5\b", re.IGNORECASE), "pm25"),
    (re.compile(r"\bpm[\s\-]?10\b", re.IGNORECASE), "pm10"),
    (re.compile(r"\bpm[\s\-]?1\b", re.IGNORECASE), "pm1"),
    (re.compile(r"\bno2\b|\bnitrogen dioxide\b", re.IGNORECASE), "nitrogendioxide"),
    (re.compile(r"\bnox\b|\bnitrogen oxides\b", re.IGNORECASE), "nitrogenoxides"),
    (re.compile(r"\bno\b|\bnitrogen monoxide\b", re.IGNORECASE), "nitrogenmonoxide"),
    (re.compile(r"\bo3\b|\bozone\b", re.IGNORECASE), "ozone"),
    (re.compile(r"\bso2\b|\bsulphur dioxide\b|\bsulfur dioxide\b", re.IGNORECASE), "sulphurdioxide"),
    (re.compile(r"\bco\b|\bcarbon monoxide\b", re.IGNORECASE), "carbonmonoxide"),
)


@dataclass(frozen=True)
class CandidateRow:
    distance_m: float
    json_station_id: str
    json_station_ref: str
    json_site_name: str
    json_station_name: str
    json_label: str
    json_connector_code: str
    json_lat: str
    json_lon: str
    aurn_uk_air_id: str
    aurn_station_name: str
    aurn_lat: str
    aurn_lon: str
    json_pollutant: str
    json_pollutant_key: str
    aurn_pollutants_raw: str
    aurn_pollutant_keys: str
    pollutant_match_status: str
    pollutant_match: str


def _normalize_pollutant_key(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    cleaned = NON_ALNUM_RE.sub("", str(value).strip().lower())
    return cleaned or None


def _canonical_pollutant_keys(value: Optional[str]) -> Set[str]:
    if not value:
        return set()
    raw = str(value).strip()
    if not raw:
        return set()

    keys: Set[str] = set()
    stripped = POLLUTANT_PARENS_RE.sub("", raw).strip()
    normalized = _normalize_pollutant_key(raw)
    if normalized:
        keys.add(normalized)
    normalized_stripped = _normalize_pollutant_key(stripped)
    if normalized_stripped:
        keys.add(normalized_stripped)

    for pattern, canonical in CANONICAL_POLLUTANT_PATTERNS:
        if pattern.search(raw):
            keys.add(canonical)
    return keys


def _parse_aurn_pollutants(raw_value: str) -> Set[str]:
    raw = (raw_value or "").strip()
    if not raw:
        return set()
    parts: List[str]
    if SIMPLE_SPLIT_RE.search(raw):
        parts = [part.strip() for part in SIMPLE_SPLIT_RE.split(raw) if part.strip()]
    else:
        parts = [raw]
    keys: Set[str] = set()
    for part in parts:
        keys.update(_canonical_pollutant_keys(part))
    return keys


def _clean_station_name(value: str) -> str:
    if not value:
        return ""
    return NON_ALNUM_RE.sub("", value.strip().lower())


def _extract_json_pollutant(label: str, station_name: str) -> str:
    clean_label = (label or "").strip()
    if not clean_label:
        return ""
    station = (station_name or "").strip()
    if station:
        marker = f"{station}-"
        if clean_label.lower().startswith(marker.lower()):
            return clean_label[len(marker) :].strip()

    # Fallback: split once on first hyphen (common "Station-Pollutant" format).
    if "-" in clean_label:
        _, right = clean_label.split("-", 1)
        return right.strip()
    return clean_label


def _infer_json_site_name(label: str, station_name: str, pollutant: str) -> str:
    clean_label = (label or "").strip()
    clean_station = (station_name or "").strip()
    clean_pollutant = (pollutant or "").strip()
    if clean_label and clean_pollutant:
        suffix = f"-{clean_pollutant}"
        if clean_label.endswith(suffix):
            inferred = clean_label[: -len(suffix)].strip()
            if inferred:
                return inferred
    return clean_station or clean_label


def _float_or_none(value: str) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _load_aurn_register(path: Path) -> Dict[str, Dict[str, str]]:
    by_uk_air_id: Dict[str, Dict[str, str]] = {}
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            uk_air_id = (row.get("UK-AIR ID") or "").strip()
            if not uk_air_id:
                continue
            by_uk_air_id[uk_air_id] = {
                "site_name": (row.get("Site Name") or "").strip(),
                "latitude": (row.get("Latitude") or "").strip(),
                "longitude": (row.get("Longitude") or "").strip(),
                "aurn_pollutants_measured": (row.get("AURN Pollutants Measured") or "").strip(),
            }
    return by_uk_air_id


def _aurn_json_sides(row: Dict[str, str]) -> Optional[Tuple[Dict[str, str], Dict[str, str]]]:
    left_source = (row.get("left_source") or "").strip().lower()
    right_source = (row.get("right_source") or "").strip().lower()
    left_connector = (row.get("left_connector_code") or "").strip().lower()
    right_connector = (row.get("right_connector_code") or "").strip().lower()

    # Common layout in this CSV: left=json, right=aurn.
    if left_source == "json" and right_connector == "aurn_register":
        return (
            {
                "station_id": row.get("left_stations_id", ""),
                "station_ref": row.get("left_station_ref", ""),
                "station_name": row.get("left_station_name", ""),
                "label": row.get("left_label", ""),
                "connector_code": row.get("left_connector_code", ""),
                "lat": row.get("left_lat", ""),
                "lon": row.get("left_lon", ""),
            },
            {
                "uk_air_id": row.get("right_aurn_uk_air_id", ""),
                "station_name": row.get("right_station_name", ""),
                "lat": row.get("right_lat", ""),
                "lon": row.get("right_lon", ""),
            },
        )

    # Defensive fallback if sides are reversed.
    if right_source == "json" and left_connector == "aurn_register":
        return (
            {
                "station_id": row.get("right_stations_id", ""),
                "station_ref": row.get("right_station_ref", ""),
                "station_name": row.get("right_station_name", ""),
                "label": row.get("right_label", ""),
                "connector_code": row.get("right_connector_code", ""),
                "lat": row.get("right_lat", ""),
                "lon": row.get("right_lon", ""),
            },
            {
                "uk_air_id": row.get("left_aurn_uk_air_id", ""),
                "station_name": row.get("left_station_name", ""),
                "lat": row.get("left_lat", ""),
                "lon": row.get("left_lon", ""),
            },
        )
    return None


def _build_candidates(
    matches_csv: Path,
    aurn_register: Dict[str, Dict[str, str]],
    distance_threshold_m: float,
) -> List[CandidateRow]:
    rows: List[CandidateRow] = []
    with matches_csv.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            if (row.get("match_type") or "").strip().lower() != "aurn-json":
                continue
            distance_value = _float_or_none(row.get("distance_m", ""))
            if distance_value is None or distance_value > distance_threshold_m:
                continue
            sides = _aurn_json_sides(row)
            if not sides:
                continue
            json_side, aurn_side = sides

            uk_air_id = (aurn_side.get("uk_air_id") or "").strip()
            register_row = aurn_register.get(uk_air_id, {})
            aurn_pollutants_raw = (register_row.get("aurn_pollutants_measured") or "").strip()
            aurn_pollutant_keys = _parse_aurn_pollutants(aurn_pollutants_raw)

            json_pollutant = _extract_json_pollutant(
                json_side.get("label", ""),
                json_side.get("station_name", ""),
            )
            json_site_name = _infer_json_site_name(
                json_side.get("label", ""),
                json_side.get("station_name", ""),
                json_pollutant,
            )
            json_keys = _canonical_pollutant_keys(json_pollutant)
            json_pollutant_key = sorted(json_keys)[0] if json_keys else ""

            if not aurn_pollutant_keys:
                match_status = "unknown_aurn_pollutants"
                match_bool = ""
            elif json_keys & aurn_pollutant_keys:
                match_status = "matched"
                match_bool = "true"
            else:
                match_status = "mismatch"
                match_bool = "false"

            rows.append(
                CandidateRow(
                    distance_m=distance_value,
                    json_station_id=(json_side.get("station_id") or "").strip(),
                    json_station_ref=(json_side.get("station_ref") or "").strip(),
                    json_site_name=(json_site_name or "").strip(),
                    json_station_name=(json_side.get("station_name") or "").strip(),
                    json_label=(json_side.get("label") or "").strip(),
                    json_connector_code=(json_side.get("connector_code") or "").strip(),
                    json_lat=(json_side.get("lat") or "").strip(),
                    json_lon=(json_side.get("lon") or "").strip(),
                    aurn_uk_air_id=uk_air_id,
                    aurn_station_name=(
                        (register_row.get("site_name") or "").strip()
                        or (aurn_side.get("station_name") or "").strip()
                    ),
                    aurn_lat=((register_row.get("latitude") or "").strip() or (aurn_side.get("lat") or "").strip()),
                    aurn_lon=((register_row.get("longitude") or "").strip() or (aurn_side.get("lon") or "").strip()),
                    json_pollutant=json_pollutant,
                    json_pollutant_key=json_pollutant_key,
                    aurn_pollutants_raw=aurn_pollutants_raw,
                    aurn_pollutant_keys="|".join(sorted(aurn_pollutant_keys)),
                    pollutant_match_status=match_status,
                    pollutant_match=match_bool,
                )
            )
    return rows


def _summarize_candidates(rows: Sequence[CandidateRow]) -> List[Dict[str, str]]:
    grouped: Dict[Tuple[str, str, str], List[CandidateRow]] = defaultdict(list)
    for row in rows:
        key = (
            row.json_site_name,
            row.json_connector_code,
            row.aurn_uk_air_id,
        )
        grouped[key].append(row)

    output: List[Dict[str, str]] = []
    for (json_site_name, json_connector_code, uk_air_id), group in sorted(grouped.items()):
        json_pollutant_keys = sorted(
            {item.json_pollutant_key for item in group if item.json_pollutant_key}
        )
        matched_count = sum(1 for item in group if item.pollutant_match_status == "matched")
        mismatch_count = sum(1 for item in group if item.pollutant_match_status == "mismatch")
        unknown_count = sum(
            1 for item in group if item.pollutant_match_status == "unknown_aurn_pollutants"
        )

        clean_json_name = _clean_station_name(json_site_name)
        clean_aurn_name = _clean_station_name(group[0].aurn_station_name) if group else ""
        name_similarity = 0.0
        name_match = "false"
        if clean_json_name and clean_aurn_name:
            name_similarity = difflib.SequenceMatcher(None, clean_json_name, clean_aurn_name).ratio()
            if (
                clean_json_name == clean_aurn_name
                or clean_json_name in clean_aurn_name
                or clean_aurn_name in clean_json_name
            ):
                name_match = "true"
        name_is_strong = name_match == "true" or name_similarity >= 0.75

        if matched_count > 0 and name_is_strong:
            confidence = "high"
            possible_duplicate = "true"
        elif unknown_count > 0 and mismatch_count == 0 and name_is_strong:
            confidence = "medium"
            possible_duplicate = "true"
        else:
            confidence = "low"
            possible_duplicate = "false"

        output.append(
            {
                "possible_duplicate": possible_duplicate,
                "confidence": confidence,
                "json_site_name": json_site_name,
                "json_connector_code": json_connector_code,
                "aurn_uk_air_id": uk_air_id,
                "aurn_station_name": group[0].aurn_station_name if group else "",
                "name_match": name_match,
                "name_similarity": f"{name_similarity:.3f}",
                "row_count": str(len(group)),
                "min_distance_m": f"{min(item.distance_m for item in group):.3f}",
                "max_distance_m": f"{max(item.distance_m for item in group):.3f}",
                "json_pollutant_count": str(len(json_pollutant_keys)),
                "json_pollutant_keys": "|".join(json_pollutant_keys),
                "pollutant_matched_count": str(matched_count),
                "pollutant_mismatch_count": str(mismatch_count),
                "pollutant_unknown_count": str(unknown_count),
                "aurn_pollutants_raw": group[0].aurn_pollutants_raw if group else "",
            }
        )
    return output


def _write_rows_csv(path: Path, rows: Sequence[CandidateRow]) -> None:
    fieldnames = [
        "distance_m",
        "json_station_id",
        "json_station_ref",
        "json_site_name",
        "json_station_name",
        "json_label",
        "json_connector_code",
        "json_lat",
        "json_lon",
        "aurn_uk_air_id",
        "aurn_station_name",
        "aurn_lat",
        "aurn_lon",
        "json_pollutant",
        "json_pollutant_key",
        "aurn_pollutants_raw",
        "aurn_pollutant_keys",
        "pollutant_match_status",
        "pollutant_match",
    ]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "distance_m": f"{row.distance_m:.3f}",
                    "json_station_id": row.json_station_id,
                    "json_station_ref": row.json_station_ref,
                    "json_site_name": row.json_site_name,
                    "json_station_name": row.json_station_name,
                    "json_label": row.json_label,
                    "json_connector_code": row.json_connector_code,
                    "json_lat": row.json_lat,
                    "json_lon": row.json_lon,
                    "aurn_uk_air_id": row.aurn_uk_air_id,
                    "aurn_station_name": row.aurn_station_name,
                    "aurn_lat": row.aurn_lat,
                    "aurn_lon": row.aurn_lon,
                    "json_pollutant": row.json_pollutant,
                    "json_pollutant_key": row.json_pollutant_key,
                    "aurn_pollutants_raw": row.aurn_pollutants_raw,
                    "aurn_pollutant_keys": row.aurn_pollutant_keys,
                    "pollutant_match_status": row.pollutant_match_status,
                    "pollutant_match": row.pollutant_match,
                }
            )


def _write_summary_csv(path: Path, rows: Sequence[Dict[str, str]]) -> None:
    fieldnames = [
        "possible_duplicate",
        "confidence",
        "json_site_name",
        "json_connector_code",
        "aurn_uk_air_id",
        "aurn_station_name",
        "name_match",
        "name_similarity",
        "row_count",
        "min_distance_m",
        "max_distance_m",
        "json_pollutant_count",
        "json_pollutant_keys",
        "pollutant_matched_count",
        "pollutant_mismatch_count",
        "pollutant_unknown_count",
        "aurn_pollutants_raw",
    ]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create pollutant-aware possible duplicate station lists from "
            "json/aurn spatial match CSV output."
        )
    )
    parser.add_argument(
        "--matches-csv",
        default=str(DEFAULT_MATCHES_CSV),
        help=f"Path to match CSV (default: {DEFAULT_MATCHES_CSV})",
    )
    parser.add_argument(
        "--aurn-register-csv",
        default=str(DEFAULT_AURN_REGISTER_CSV),
        help=f"Path to AURN site register CSV (default: {DEFAULT_AURN_REGISTER_CSV})",
    )
    parser.add_argument(
        "--distance-threshold-m",
        type=float,
        default=30.0,
        help="Maximum match distance in meters (default: 30).",
    )
    parser.add_argument(
        "--output-rows-csv",
        default=str(DEFAULT_OUTPUT_ROWS_CSV),
        help=f"Row-level output CSV (default: {DEFAULT_OUTPUT_ROWS_CSV})",
    )
    parser.add_argument(
        "--output-stations-csv",
        default=str(DEFAULT_OUTPUT_STATIONS_CSV),
        help=f"Station-pair summary CSV (default: {DEFAULT_OUTPUT_STATIONS_CSV})",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    matches_csv = Path(args.matches_csv)
    aurn_register_csv = Path(args.aurn_register_csv)
    output_rows_csv = Path(args.output_rows_csv)
    output_stations_csv = Path(args.output_stations_csv)

    if not matches_csv.exists():
        raise FileNotFoundError(f"Match CSV not found: {matches_csv}")
    if not aurn_register_csv.exists():
        raise FileNotFoundError(f"AURN register CSV not found: {aurn_register_csv}")

    aurn_register = _load_aurn_register(aurn_register_csv)
    candidate_rows = _build_candidates(
        matches_csv=matches_csv,
        aurn_register=aurn_register,
        distance_threshold_m=float(args.distance_threshold_m),
    )
    summary_rows = _summarize_candidates(candidate_rows)

    output_rows_csv.parent.mkdir(parents=True, exist_ok=True)
    output_stations_csv.parent.mkdir(parents=True, exist_ok=True)
    _write_rows_csv(output_rows_csv, candidate_rows)
    _write_summary_csv(output_stations_csv, summary_rows)

    possible_duplicates = sum(1 for row in summary_rows if row["possible_duplicate"] == "true")
    print(f"Wrote row-level candidates: {output_rows_csv} ({len(candidate_rows)} rows)")
    print(f"Wrote station summary:    {output_stations_csv} ({len(summary_rows)} rows)")
    print(f"Possible duplicates:      {possible_duplicates}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
