#!/usr/bin/env python3
"""Sync uk_aq_core reference tables from ingest Supabase to agg_daily Supabase.

Sync semantics:
- Source of truth rows are read from ingest via PostgREST.
- Destination rows are upserted by primary key.
- Destination rows missing from source are hard-deleted by primary key.

Tables synced (dependency order):
1) connectors
2) phenomena
3) stations
4) timeseries
"""

from __future__ import annotations

import difflib
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import requests

PRIMARY_TABLES: List[str] = ["connectors", "phenomena", "stations", "timeseries"]
DEPENDENCY_TABLES: List[str] = [
    "observed_properties",
    "categories",
    "offerings",
    "features",
    "procedures",
]
SYNC_TABLES: List[str] = [
    "connectors",
    "observed_properties",
    "categories",
    "phenomena",
    "offerings",
    "features",
    "procedures",
    "stations",
    "timeseries",
]
DELETE_ORDER: List[str] = [
    "timeseries",
    "stations",
    "procedures",
    "features",
    "offerings",
    "phenomena",
    "categories",
    "observed_properties",
    "connectors",
]
CORE_SCHEMA = "uk_aq_core"
PUBLIC_SCHEMA = "uk_aq_public"

PAGE_SIZE = 1000
UPSERT_BATCH_SIZE = 500
DELETE_BATCH_SIZE = 250

COLUMNS_RPC = "uk_aq_rpc_info_schema_columns"
PK_RPC = "uk_aq_rpc_info_schema_primary_keys"

# Static source metadata fallback copied from ingest uk_aq_core DDL
# (`schemas/ingest_db/uk_aq_core_schema.sql`) for the four mirrored tables.
STATIC_SOURCE_TABLE_META: Dict[str, Dict[str, Any]] = {
    "connectors": {
        "pk": ["id"],
        "columns": [
            {"column_name": "id", "udt_name": "int4", "is_nullable": "NO", "column_default": None, "ordinal_position": 1},
            {"column_name": "connector_code", "udt_name": "text", "is_nullable": "NO", "column_default": None, "ordinal_position": 2},
            {"column_name": "label", "udt_name": "text", "is_nullable": "NO", "column_default": None, "ordinal_position": 3},
            {"column_name": "display_name", "udt_name": "text", "is_nullable": "YES", "column_default": None, "ordinal_position": 4},
            {"column_name": "service_url", "udt_name": "text", "is_nullable": "YES", "column_default": None, "ordinal_position": 5},
            {"column_name": "station_display_name_template", "udt_name": "text", "is_nullable": "YES", "column_default": None, "ordinal_position": 6},
            {"column_name": "overwrite_station_name", "udt_name": "bool", "is_nullable": "YES", "column_default": "true", "ordinal_position": 7},
            {"column_name": "poll_enabled", "udt_name": "bool", "is_nullable": "YES", "column_default": "true", "ordinal_position": 8},
            {"column_name": "poll_interval_minutes", "udt_name": "int4", "is_nullable": "YES", "column_default": "60", "ordinal_position": 9},
            {"column_name": "poll_window_hours", "udt_name": "int4", "is_nullable": "YES", "column_default": "6", "ordinal_position": 10},
            {"column_name": "poll_timeseries_batch_size", "udt_name": "int4", "is_nullable": "YES", "column_default": None, "ordinal_position": 11},
            {"column_name": "scheduler_backend", "udt_name": "text", "is_nullable": "NO", "column_default": "'supabase_function'", "ordinal_position": 12},
            {"column_name": "stations_bbox_supported", "udt_name": "bool", "is_nullable": "YES", "column_default": "true", "ordinal_position": 13},
            {"column_name": "timeseries_station_filter_supported", "udt_name": "bool", "is_nullable": "YES", "column_default": "true", "ordinal_position": 14},
            {"column_name": "last_polled_at", "udt_name": "timestamptz", "is_nullable": "YES", "column_default": None, "ordinal_position": 15},
            {"column_name": "last_run_start", "udt_name": "timestamptz", "is_nullable": "YES", "column_default": None, "ordinal_position": 16},
            {"column_name": "last_run_end", "udt_name": "timestamptz", "is_nullable": "YES", "column_default": None, "ordinal_position": 17},
            {"column_name": "last_run_status", "udt_name": "text", "is_nullable": "YES", "column_default": None, "ordinal_position": 18},
            {"column_name": "last_run_message", "udt_name": "text", "is_nullable": "YES", "column_default": None, "ordinal_position": 19},
            {"column_name": "created_at", "udt_name": "timestamptz", "is_nullable": "YES", "column_default": "now()", "ordinal_position": 20},
        ],
    },
    "phenomena": {
        "pk": ["id"],
        "columns": [
            {"column_name": "id", "udt_name": "int8", "is_nullable": "NO", "column_default": None, "ordinal_position": 1},
            {"column_name": "label", "udt_name": "text", "is_nullable": "NO", "column_default": None, "ordinal_position": 2},
            {"column_name": "source_label", "udt_name": "text", "is_nullable": "YES", "column_default": None, "ordinal_position": 3},
            {"column_name": "notation", "udt_name": "text", "is_nullable": "YES", "column_default": None, "ordinal_position": 4},
            {"column_name": "pollutant_label", "udt_name": "text", "is_nullable": "YES", "column_default": None, "ordinal_position": 5},
            {"column_name": "observed_property_id", "udt_name": "int8", "is_nullable": "YES", "column_default": None, "ordinal_position": 6},
            {"column_name": "connector_id", "udt_name": "int4", "is_nullable": "NO", "column_default": None, "ordinal_position": 7},
        ],
    },
    "stations": {
        "pk": ["id"],
        "columns": [
            {"column_name": "id", "udt_name": "int8", "is_nullable": "NO", "column_default": None, "ordinal_position": 1},
            {"column_name": "station_ref", "udt_name": "text", "is_nullable": "NO", "column_default": None, "ordinal_position": 2},
            {"column_name": "service_ref", "udt_name": "text", "is_nullable": "NO", "column_default": None, "ordinal_position": 3},
            {"column_name": "label", "udt_name": "text", "is_nullable": "NO", "column_default": None, "ordinal_position": 4},
            {"column_name": "station_name", "udt_name": "text", "is_nullable": "YES", "column_default": None, "ordinal_position": 5},
            {"column_name": "station_type", "udt_name": "text", "is_nullable": "YES", "column_default": None, "ordinal_position": 6},
            {"column_name": "station_exposure", "udt_name": "text", "is_nullable": "YES", "column_default": None, "ordinal_position": 7},
            {"column_name": "region", "udt_name": "text", "is_nullable": "YES", "column_default": None, "ordinal_position": 8},
            {"column_name": "la_code", "udt_name": "text", "is_nullable": "YES", "column_default": None, "ordinal_position": 9},
            {"column_name": "la_version", "udt_name": "text", "is_nullable": "YES", "column_default": None, "ordinal_position": 10},
            {"column_name": "pcon_code", "udt_name": "text", "is_nullable": "YES", "column_default": None, "ordinal_position": 11},
            {"column_name": "pcon_version", "udt_name": "text", "is_nullable": "YES", "column_default": None, "ordinal_position": 12},
            {"column_name": "geometry", "udt_name": "geography", "is_nullable": "YES", "column_default": None, "ordinal_position": 13},
            {"column_name": "connector_id", "udt_name": "int4", "is_nullable": "NO", "column_default": None, "ordinal_position": 14},
            {"column_name": "category_id", "udt_name": "int8", "is_nullable": "YES", "column_default": None, "ordinal_position": 15},
            {"column_name": "first_seen_at", "udt_name": "timestamptz", "is_nullable": "YES", "column_default": "now()", "ordinal_position": 16},
            {"column_name": "last_seen_at", "udt_name": "timestamptz", "is_nullable": "YES", "column_default": None, "ordinal_position": 17},
            {"column_name": "removed_at", "udt_name": "timestamptz", "is_nullable": "YES", "column_default": None, "ordinal_position": 18},
            {"column_name": "created_at", "udt_name": "timestamptz", "is_nullable": "YES", "column_default": "now()", "ordinal_position": 19},
        ],
    },
    "timeseries": {
        "pk": ["id"],
        "columns": [
            {"column_name": "id", "udt_name": "int4", "is_nullable": "NO", "column_default": None, "ordinal_position": 1},
            {"column_name": "timeseries_ref", "udt_name": "text", "is_nullable": "NO", "column_default": None, "ordinal_position": 2},
            {"column_name": "label", "udt_name": "text", "is_nullable": "NO", "column_default": None, "ordinal_position": 3},
            {"column_name": "uom", "udt_name": "text", "is_nullable": "YES", "column_default": None, "ordinal_position": 4},
            {"column_name": "station_id", "udt_name": "int8", "is_nullable": "YES", "column_default": None, "ordinal_position": 5},
            {"column_name": "service_ref", "udt_name": "text", "is_nullable": "NO", "column_default": None, "ordinal_position": 6},
            {"column_name": "connector_id", "udt_name": "int4", "is_nullable": "NO", "column_default": None, "ordinal_position": 7},
            {"column_name": "offering_id", "udt_name": "int8", "is_nullable": "YES", "column_default": None, "ordinal_position": 8},
            {"column_name": "feature_id", "udt_name": "int8", "is_nullable": "YES", "column_default": None, "ordinal_position": 9},
            {"column_name": "procedure_id", "udt_name": "int8", "is_nullable": "YES", "column_default": None, "ordinal_position": 10},
            {"column_name": "phenomenon_id", "udt_name": "int8", "is_nullable": "YES", "column_default": None, "ordinal_position": 11},
            {"column_name": "category_id", "udt_name": "int8", "is_nullable": "YES", "column_default": None, "ordinal_position": 12},
            {"column_name": "first_value_at", "udt_name": "timestamptz", "is_nullable": "YES", "column_default": None, "ordinal_position": 13},
            {"column_name": "last_value_at", "udt_name": "timestamptz", "is_nullable": "YES", "column_default": None, "ordinal_position": 14},
            {"column_name": "last_value", "udt_name": "float8", "is_nullable": "YES", "column_default": None, "ordinal_position": 15},
            {"column_name": "extras", "udt_name": "jsonb", "is_nullable": "YES", "column_default": None, "ordinal_position": 16},
            {"column_name": "rendering_hints", "udt_name": "jsonb", "is_nullable": "YES", "column_default": None, "ordinal_position": 17},
            {"column_name": "status_intervals", "udt_name": "jsonb", "is_nullable": "YES", "column_default": None, "ordinal_position": 18},
            {"column_name": "created_at", "udt_name": "timestamptz", "is_nullable": "YES", "column_default": "now()", "ordinal_position": 19},
            {"column_name": "updated_at", "udt_name": "timestamptz", "is_nullable": "YES", "column_default": "now()", "ordinal_position": 20},
        ],
    },
}


class SyncError(RuntimeError):
    """Fatal sync error."""


@dataclass(frozen=True)
class ColumnMeta:
    table_name: str
    column_name: str
    udt_name: str
    is_nullable: str
    column_default: Optional[str]
    ordinal_position: int

    def normalized(self) -> "ColumnMeta":
        return ColumnMeta(
            table_name=self.table_name,
            column_name=self.column_name,
            udt_name=self.udt_name,
            is_nullable=self.is_nullable,
            column_default=normalize_default(self.column_default),
            ordinal_position=self.ordinal_position,
        )


def required_env(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if not value:
        raise SyncError(f"Missing required environment variable: {name}")
    return value


def chunks(items: Sequence[Any], size: int) -> Iterable[Sequence[Any]]:
    if size <= 0:
        raise ValueError("chunk size must be > 0")
    for i in range(0, len(items), size):
        yield items[i : i + size]


def normalize_default(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None

    # Strip wrapping parentheses that PostgreSQL may add.
    while text.startswith("(") and text.endswith(")"):
        inner = text[1:-1].strip()
        if not inner:
            break
        text = inner

    # Remove explicit casts for comparison stability.
    text = re.sub(r"::[a-zA-Z_][a-zA-Z0-9_\.\[\]]*", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text.lower()


def format_filter_literal(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    text = str(value).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{text}"'


def parse_udt_from_column_def(column_def: str) -> str:
    lowered = column_def.lower().strip()
    if lowered.startswith("integer") or lowered.startswith("int ") or lowered == "int":
        return "int4"
    if lowered.startswith("bigint"):
        return "int8"
    if lowered.startswith("smallint"):
        return "int2"
    if lowered.startswith("text"):
        return "text"
    if lowered.startswith("boolean"):
        return "bool"
    if lowered.startswith("timestamptz"):
        return "timestamptz"
    if lowered.startswith("double precision"):
        return "float8"
    if lowered.startswith("jsonb"):
        return "jsonb"
    if lowered.startswith("geography"):
        return "geography"
    if lowered.startswith("uuid"):
        return "uuid"
    if lowered.startswith("numeric"):
        return "numeric"
    raise SyncError(f"Unsupported column type in source DDL: {column_def}")


def extract_table_block(sql_text: str, table_name: str) -> str:
    pattern = re.compile(
        rf"create\s+table\s+if\s+not\s+exists\s+(?:\"?[a-zA-Z_][a-zA-Z0-9_]*\"?\.)?\"?{re.escape(table_name)}\"?\s*\(",
        re.IGNORECASE,
    )
    match = pattern.search(sql_text)
    if not match:
        raise SyncError(f"Could not find CREATE TABLE for {table_name} in source schema SQL")

    start_paren = match.end() - 1
    depth = 0
    end_pos = -1
    for idx in range(start_paren, len(sql_text)):
        char = sql_text[idx]
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                end_pos = idx
                break

    if end_pos < 0:
        raise SyncError(f"Could not parse CREATE TABLE column block for {table_name}")

    return sql_text[start_paren + 1 : end_pos]


def parse_source_table_metadata(schema_sql_path: Path, table_names: Sequence[str]) -> Tuple[Dict[str, List[ColumnMeta]], Dict[str, List[str]]]:
    if not schema_sql_path.exists():
        raise SyncError(f"Source schema SQL file not found: {schema_sql_path}")

    sql_text = schema_sql_path.read_text(encoding="utf-8")
    columns_by_table: Dict[str, List[ColumnMeta]] = {}
    pk_by_table: Dict[str, List[str]] = {}

    for table in table_names:
        block = extract_table_block(sql_text, table)
        ordinal = 0
        cols: List[ColumnMeta] = []
        pks: List[str] = []

        for raw_line in block.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("--"):
                continue
            if line.endswith(","):
                line = line[:-1].strip()
            if not line:
                continue

            keyword = line.split(None, 1)[0].lower()
            if keyword in {"constraint", "foreign", "unique", "check"}:
                continue
            if keyword == "primary":
                pk_match = re.search(r"primary\s+key\s*\(([^)]+)\)", line, re.IGNORECASE)
                if pk_match:
                    for part in pk_match.group(1).split(","):
                        pks.append(part.strip().strip('"'))
                continue

            col_name = line.split(None, 1)[0].strip().strip('"')
            col_def = line[len(line.split(None, 1)[0]) :].strip()
            col_def_lower = col_def.lower()

            ordinal += 1
            udt_name = parse_udt_from_column_def(col_def)
            is_nullable = "NO" if " not null" in col_def_lower else "YES"
            if " primary key" in col_def_lower:
                is_nullable = "NO"
                pks.append(col_name)

            if "generated by default as identity" in col_def_lower:
                column_default: Optional[str] = None
            else:
                default_match = re.search(r"\bdefault\b\s+(.+)", col_def, re.IGNORECASE)
                if default_match:
                    expr = default_match.group(1).strip()
                    expr = re.split(
                        r"\s+(?:not\s+null|references|primary\s+key|check|constraint)\b",
                        expr,
                        maxsplit=1,
                        flags=re.IGNORECASE,
                    )[0].strip()
                    column_default = expr or None
                else:
                    column_default = None

            cols.append(
                ColumnMeta(
                    table_name=table,
                    column_name=col_name,
                    udt_name=udt_name,
                    is_nullable=is_nullable,
                    column_default=column_default,
                    ordinal_position=ordinal,
                )
            )

        if not cols:
            raise SyncError(f"No columns parsed for {table} from source schema SQL")
        if not pks:
            raise SyncError(f"No primary key parsed for {table} from source schema SQL")

        pk_set = set(pks)
        cols = [
            ColumnMeta(
                table_name=c.table_name,
                column_name=c.column_name,
                udt_name=c.udt_name,
                is_nullable="NO" if c.column_name in pk_set else c.is_nullable,
                column_default=c.column_default,
                ordinal_position=c.ordinal_position,
            )
            for c in cols
        ]

        columns_by_table[table] = cols
        pk_by_table[table] = pks

    return columns_by_table, pk_by_table


def static_source_metadata(table_names: Sequence[str]) -> Tuple[Dict[str, List[ColumnMeta]], Dict[str, List[str]]]:
    columns_by_table: Dict[str, List[ColumnMeta]] = {}
    pk_by_table: Dict[str, List[str]] = {}

    for table in table_names:
        meta = STATIC_SOURCE_TABLE_META.get(table)
        if not meta:
            raise SyncError(f"Static source metadata missing for table: {table}")

        raw_cols = meta.get("columns") or []
        raw_pk = meta.get("pk") or []
        if not raw_cols:
            raise SyncError(f"Static source metadata has no columns for table: {table}")
        if not raw_pk:
            raise SyncError(f"Static source metadata has no primary key for table: {table}")

        cols: List[ColumnMeta] = []
        for item in raw_cols:
            cols.append(
                ColumnMeta(
                    table_name=table,
                    column_name=str(item["column_name"]),
                    udt_name=str(item["udt_name"]),
                    is_nullable=str(item["is_nullable"]),
                    column_default=item.get("column_default"),
                    ordinal_position=int(item["ordinal_position"]),
                )
            )

        columns_by_table[table] = sorted(cols, key=lambda c: c.ordinal_position)
        pk_by_table[table] = [str(x) for x in raw_pk]

    return columns_by_table, pk_by_table


def load_source_metadata(
    *,
    src_client: "PostgrestClient",
    schema_sql_path: Path,
    tables: Sequence[str],
) -> Tuple[Dict[str, List[ColumnMeta]], Dict[str, List[str]], str]:
    # Preferred: query source information_schema via RPC when available.
    try:
        src_column_rows = src_client.rpc(
            COLUMNS_RPC,
            profile=PUBLIC_SCHEMA,
            args={"p_schema": CORE_SCHEMA, "p_table_names": list(tables)},
        )
        src_pk_rows = src_client.rpc(
            PK_RPC,
            profile=PUBLIC_SCHEMA,
            args={"p_schema": CORE_SCHEMA, "p_table_names": list(tables)},
        )
        if isinstance(src_column_rows, list) and isinstance(src_pk_rows, list):
            src_cols, src_pk = build_meta_maps(src_column_rows, src_pk_rows)
            missing = [t for t in tables if not src_cols.get(t) or not src_pk.get(t)]
            if not missing:
                return src_cols, src_pk, "source_rpc"
            print(
                f"WARN: source metadata RPC missing required tables {missing}; falling back.",
                file=sys.stderr,
            )
    except SyncError as exc:
        print(f"WARN: source metadata RPC unavailable: {exc}; falling back.", file=sys.stderr)

    # Fallback: parse source DDL from local schema checkout when available.
    if schema_sql_path.exists():
        try:
            src_cols, src_pk = parse_source_table_metadata(schema_sql_path, tables)
            return src_cols, src_pk, f"schema_sql:{schema_sql_path}"
        except SyncError as exc:
            print(f"WARN: source schema SQL parse failed: {exc}; falling back.", file=sys.stderr)

    # Final fallback: embedded static metadata from ingest DDL.
    src_cols, src_pk = static_source_metadata(tables)
    return src_cols, src_pk, "embedded_static"


class PostgrestClient:
    def __init__(self, *, base_url: str, secret_key: str, caller: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.secret_key = secret_key
        self.caller = caller

    def _headers(self, profile: str, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        headers: Dict[str, str] = {
            "apikey": self.secret_key,
            "Authorization": f"Bearer {self.secret_key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Accept-Profile": profile,
            "Content-Profile": profile,
            "x-ukaq-egress-caller": self.caller,
        }
        if extra:
            headers.update(extra)
        return headers

    def request_json(
        self,
        method: str,
        path: str,
        *,
        profile: str,
        params: Optional[Dict[str, str]] = None,
        payload: Optional[Any] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        timeout: int = 60,
    ) -> Any:
        url = f"{self.base_url}{path}"
        response = requests.request(
            method=method,
            url=url,
            headers=self._headers(profile, extra_headers),
            params=params,
            json=payload,
            timeout=timeout,
        )

        if not response.ok:
            body = response.text.strip()
            # Supabase/PostgREST returns 406 PGRST106 when schema is not exposed.
            if response.status_code == 406 and "PGRST106" in body and f"Invalid schema: {CORE_SCHEMA}" in body:
                raise SyncError(
                    "Destination project API does not expose schema "
                    f"'{CORE_SCHEMA}'. Add '{CORE_SCHEMA}' to Supabase API "
                    "Exposed schemas for the destination (agg_daily) project, "
                    "then re-run this workflow."
                )
            raise SyncError(
                f"PostgREST {method} {path} failed ({response.status_code}): {body or response.reason}"
            )

        if response.status_code == 204 or not response.text.strip():
            return []
        return response.json()

    def fetch_all_rows(
        self,
        table: str,
        *,
        profile: str,
        select: str,
        order: Optional[str] = None,
        page_size: int = PAGE_SIZE,
    ) -> List[Dict[str, Any]]:
        rows: List[Dict[str, Any]] = []
        offset = 0

        while True:
            params: Dict[str, str] = {
                "select": select,
                "limit": str(page_size),
                "offset": str(offset),
            }
            if order:
                params["order"] = order

            batch = self.request_json("GET", f"/rest/v1/{table}", profile=profile, params=params)
            if not isinstance(batch, list):
                raise SyncError(f"Expected list response for {table}, got: {type(batch).__name__}")

            rows.extend(batch)
            if len(batch) < page_size:
                break
            offset += len(batch)

        return rows

    def upsert_rows(
        self,
        table: str,
        *,
        profile: str,
        rows: Sequence[Dict[str, Any]],
        on_conflict: str,
    ) -> None:
        if not rows:
            return
        self.request_json(
            "POST",
            f"/rest/v1/{table}",
            profile=profile,
            params={"on_conflict": on_conflict},
            payload=list(rows),
            extra_headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
            timeout=120,
        )

    def delete_where(
        self,
        table: str,
        *,
        profile: str,
        params: Dict[str, str],
    ) -> None:
        self.request_json(
            "DELETE",
            f"/rest/v1/{table}",
            profile=profile,
            params=params,
            extra_headers={"Prefer": "return=minimal"},
            timeout=120,
        )

    def rpc(self, name: str, *, profile: str, args: Dict[str, Any]) -> Any:
        return self.request_json(
            "POST",
            f"/rest/v1/rpc/{name}",
            profile=profile,
            payload=args,
            timeout=60,
        )


def build_meta_maps(
    column_rows: Sequence[Dict[str, Any]],
    pk_rows: Sequence[Dict[str, Any]],
) -> Tuple[Dict[str, List[ColumnMeta]], Dict[str, List[str]]]:
    columns_by_table: Dict[str, List[ColumnMeta]] = {}
    for row in column_rows:
        table_name = str(row.get("table_name") or "").strip()
        if not table_name:
            continue
        item = ColumnMeta(
            table_name=table_name,
            column_name=str(row.get("column_name") or "").strip(),
            udt_name=str(row.get("udt_name") or "").strip(),
            is_nullable=str(row.get("is_nullable") or "").strip(),
            column_default=row.get("column_default"),
            ordinal_position=int(row.get("ordinal_position") or 0),
        )
        columns_by_table.setdefault(table_name, []).append(item)

    for table_name, cols in list(columns_by_table.items()):
        columns_by_table[table_name] = sorted(cols, key=lambda c: c.ordinal_position)

    pk_by_table: Dict[str, List[Tuple[int, str]]] = {}
    for row in pk_rows:
        table_name = str(row.get("table_name") or "").strip()
        if not table_name:
            continue
        pk_by_table.setdefault(table_name, []).append(
            (int(row.get("ordinal_position") or 0), str(row.get("column_name") or "").strip())
        )

    ordered_pk: Dict[str, List[str]] = {}
    for table_name, values in pk_by_table.items():
        ordered_pk[table_name] = [col for _, col in sorted(values, key=lambda x: x[0])]

    return columns_by_table, ordered_pk


def format_column_lines(columns: Sequence[ColumnMeta]) -> List[str]:
    return [
        json.dumps(
            {
                "table": c.table_name,
                "ordinal_position": c.ordinal_position,
                "column_name": c.column_name,
                "udt_name": c.udt_name,
                "is_nullable": c.is_nullable,
                "column_default": normalize_default(c.column_default),
            },
            sort_keys=True,
        )
        for c in columns
    ]


def verify_schema_matches(
    *,
    source_columns_by_table: Dict[str, List[ColumnMeta]],
    source_pk_by_table: Dict[str, List[str]],
    dest_columns_by_table: Dict[str, List[ColumnMeta]],
    dest_pk_by_table: Dict[str, List[str]],
    tables: Sequence[str],
) -> None:
    errors: List[str] = []

    for table in tables:
        src_cols = [c.normalized() for c in source_columns_by_table.get(table, [])]
        dst_cols = [c.normalized() for c in dest_columns_by_table.get(table, [])]
        if not src_cols:
            errors.append(f"{table}: source columns missing")
            continue
        if not dst_cols:
            errors.append(f"{table}: destination columns missing")
            continue

        src_lines = format_column_lines(src_cols)
        dst_lines = format_column_lines(dst_cols)
        if src_lines != dst_lines:
            diff = "\n".join(
                difflib.unified_diff(
                    src_lines,
                    dst_lines,
                    fromfile=f"source:{table}",
                    tofile=f"dest:{table}",
                    lineterm="",
                )
            )
            errors.append(f"{table}: column definition mismatch\n{diff}")

        src_pk = source_pk_by_table.get(table, [])
        dst_pk = dest_pk_by_table.get(table, [])
        if src_pk != dst_pk:
            errors.append(
                f"{table}: primary key mismatch\n"
                f"  source={src_pk}\n"
                f"  dest={dst_pk}"
            )

    if errors:
        raise SyncError("Schema verification failed:\n\n" + "\n\n".join(errors))


def pk_tuple(row: Dict[str, Any], pk_columns: Sequence[str]) -> Tuple[Any, ...]:
    return tuple(row.get(col) for col in pk_columns)


def delete_missing_rows(
    *,
    client: PostgrestClient,
    table: str,
    profile: str,
    pk_columns: Sequence[str],
    missing_keys: Sequence[Tuple[Any, ...]],
) -> int:
    if not missing_keys:
        return 0

    deleted = 0

    if len(pk_columns) == 1:
        pk_col = pk_columns[0]
        values = [key[0] for key in missing_keys]
        for batch in chunks(values, DELETE_BATCH_SIZE):
            in_values = ",".join(format_filter_literal(v) for v in batch)
            client.delete_where(
                table,
                profile=profile,
                params={pk_col: f"in.({in_values})"},
            )
            deleted += len(batch)
        return deleted

    # Composite PK fallback: per-row delete with AND filters.
    for key in missing_keys:
        params: Dict[str, str] = {}
        for col, value in zip(pk_columns, key):
            params[col] = f"eq.{format_filter_literal(value)}"
        client.delete_where(table, profile=profile, params=params)
        deleted += 1

    return deleted


def main() -> int:
    src_url = required_env("SRC_SUPABASE_URL")
    src_key = required_env("SRC_SECRET_KEY")
    dst_url = required_env("DST_SUPABASE_URL")
    dst_key = required_env("DST_SECRET_KEY")

    schema_sql_path = Path(
        os.getenv(
            "UK_AQ_INGEST_CORE_SCHEMA_SQL_PATH",
            "../CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/ingest_db/uk_aq_core_schema.sql",
        )
    )

    src_client = PostgrestClient(
        base_url=src_url,
        secret_key=src_key,
        caller="stations_daily_sync_aggdaily_source",
    )
    dst_client = PostgrestClient(
        base_url=dst_url,
        secret_key=dst_key,
        caller="stations_daily_sync_aggdaily_dest",
    )

    source_columns, source_pk, source_meta_mode = load_source_metadata(
        src_client=src_client,
        schema_sql_path=schema_sql_path,
        tables=PRIMARY_TABLES,
    )
    print(f"Loaded source schema metadata via: {source_meta_mode}")

    try:
        dst_column_rows = dst_client.rpc(
            COLUMNS_RPC,
            profile=PUBLIC_SCHEMA,
            args={"p_schema": CORE_SCHEMA, "p_table_names": SYNC_TABLES},
        )
        dst_pk_rows = dst_client.rpc(
            PK_RPC,
            profile=PUBLIC_SCHEMA,
            args={"p_schema": CORE_SCHEMA, "p_table_names": SYNC_TABLES},
        )
    except SyncError as exc:
        message = str(exc)
        if "PGRST202" in message or "Could not find the function" in message:
            raise SyncError(
                "Destination metadata RPCs are missing. Apply aggdaily schema SQL first: "
                "schemas/aggdaily_db/uk_aq_aggdaily_schema.sql"
            ) from exc
        raise

    if not isinstance(dst_column_rows, list) or not isinstance(dst_pk_rows, list):
        raise SyncError("Destination metadata RPCs returned unexpected payloads")

    dest_columns, dest_pk = build_meta_maps(dst_column_rows, dst_pk_rows)

    verify_schema_matches(
        source_columns_by_table=source_columns,
        source_pk_by_table=source_pk,
        dest_columns_by_table=dest_columns,
        dest_pk_by_table=dest_pk,
        tables=PRIMARY_TABLES,
    )

    print("Schema verification passed for all primary sync tables.")

    table_stats: Dict[str, Dict[str, Any]] = {}
    missing_by_table: Dict[str, List[Tuple[Any, ...]]] = {}

    # Phase 1: upsert all rows for dependency-safe set of tables.
    for table in SYNC_TABLES:
        pk_columns = dest_pk.get(table, [])
        if not pk_columns:
            raise SyncError(f"{table}: no destination PK columns found")

        order_expr = ",".join(f"{col}.asc" for col in pk_columns)

        source_rows = src_client.fetch_all_rows(
            table,
            profile=CORE_SCHEMA,
            select="*",
            order=order_expr,
        )

        source_count = len(source_rows)
        for batch in chunks(source_rows, UPSERT_BATCH_SIZE):
            dst_client.upsert_rows(
                table,
                profile=CORE_SCHEMA,
                rows=batch,
                on_conflict=",".join(pk_columns),
            )

        source_pk_set = {pk_tuple(row, pk_columns) for row in source_rows}
        dst_pk_rows_before_delete = dst_client.fetch_all_rows(
            table,
            profile=CORE_SCHEMA,
            select=",".join(pk_columns),
            order=order_expr,
        )
        dest_pk_set = {pk_tuple(row, pk_columns) for row in dst_pk_rows_before_delete}
        missing_by_table[table] = sorted(dest_pk_set - source_pk_set)
        table_stats[table] = {
            "table": table,
            "source_row_count": source_count,
            "upsert_attempted": source_count,
            "destination_row_count_after_sync": len(dest_pk_set),
            "deleted": 0,
            "pk_columns": pk_columns,
        }

    # Phase 2: hard-delete rows missing in source in FK-safe reverse order.
    for table in DELETE_ORDER:
        pk_columns = dest_pk.get(table, [])
        if not pk_columns:
            raise SyncError(f"{table}: no destination PK columns found for delete phase")
        order_expr = ",".join(f"{col}.asc" for col in pk_columns)

        deleted = delete_missing_rows(
            client=dst_client,
            table=table,
            profile=CORE_SCHEMA,
            pk_columns=pk_columns,
            missing_keys=missing_by_table.get(table, []),
        )

        dst_pk_rows_after_delete = dst_client.fetch_all_rows(
            table,
            profile=CORE_SCHEMA,
            select=",".join(pk_columns),
            order=order_expr,
        )
        table_stats[table]["deleted"] = deleted
        table_stats[table]["destination_row_count_after_sync"] = len(dst_pk_rows_after_delete)

    for table in SYNC_TABLES:
        print(json.dumps(table_stats[table], sort_keys=True))

    print("uk_aq_core sync to agg_daily completed successfully.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SyncError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
