import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts.uk_air_sos_ingest import (
    SupabaseWriter,
    _parse_datapoints,
)


def load_fixture(name: str):
    path = Path(__file__).parent / "fixtures" / name
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


class FakeTable:
    def __init__(self, name: str, store: dict):
        self.name = name
        self.store = store
        self.query = {}
        self.last_upsert = []

    # Chainable query modifiers (no-ops for this fake)
    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def in_(self, *_args, **_kwargs):
        return self

    def upsert(self, rows, on_conflict=None):  # noqa: ARG002
        if isinstance(rows, dict):
            rows = [rows]
        self.last_upsert = list(rows)
        self.store[self.name] = list(rows)
        return self

    def execute(self):
        # Return whatever was last written for this table
        return SimpleNamespace(data=self.store.get(self.name, []))


class FakeClient:
    def __init__(self):
        self.tables = {}

    def table(self, name: str) -> FakeTable:
        if name not in self.tables:
            self.tables[name] = FakeTable(name, self.tables)
        return self.tables[name]


class FakeWriter(SupabaseWriter):
    def __init__(self, client: FakeClient):  # type: ignore[super-init-not-called]
        self.client = client

    def get_connector_id(self):
        return 1

    def get_station_id_map(self, connector_id, service_ref, station_refs):  # noqa: ARG002
        return {ref: idx + 10 for idx, ref in enumerate(station_refs)}

    def get_timeseries_id_map(self, connector_id, service_ref, timeseries_refs):  # noqa: ARG002
        return {ref: idx + 100 for idx, ref in enumerate(timeseries_refs)}

    def get_phenomena_id_map(self, eionet_uris, connector_id):  # noqa: ARG002
        return {uri: idx + 1000 for idx, uri in enumerate(eionet_uris)}


def test_parse_datapoints_accepts_iso_and_numeric():
    payload = load_fixture("timeseries_getdata.json")
    points = _parse_datapoints(payload["values"])
    assert [p["value"] for p in points] == [1.0, 2.5, 3.0]
    assert all("observed_at" in p for p in points)
    # Ensure ISO string stays intact and numeric timestamps are parsed
    assert points[0]["observed_at"].startswith("2025-01-01T00:00:00")
    assert points[1]["observed_at"].endswith("Z")


def test_upserts_use_ref_fields_and_ids():
    fake = FakeClient()
    writer = FakeWriter(fake)

    services = load_fixture("services.json")["services"]
    connector_id = writer.upsert_connectors(services)
    connector_rows = fake.tables["connectors"].last_upsert
    assert connector_rows[0]["connector_code"] == "uk_air_sos"
    assert connector_id == 1

    stations = load_fixture("stations_expanded.json")["stations"]
    writer.upsert_stations(stations, connector_id=1, service_ref="1")
    station_rows = fake.tables["stations"].last_upsert
    assert station_rows[0]["station_ref"] == "100"
    assert station_rows[0]["connector_id"] == 1
    assert station_rows[0]["service_ref"] == "1"

    series = load_fixture("timeseries_expanded.json")["timeseries"]
    phenomena = [ts.get("phenomenon", {}) for ts in series]
    writer.upsert_phenomena(phenomena, connector_id=1)
    phen_rows = fake.tables["phenomena"].last_upsert
    assert phen_rows[0]["eionet_uri"].startswith("http://dd.eionet.europa.eu")
    assert phen_rows[0]["notation"] == "NO2"

    phenomenon_map = writer.get_phenomena_id_map([phen_rows[0]["eionet_uri"]], connector_id=1)
    category_map = {"cat-1": 201}
    feature_map = {"feat-1": 301}
    procedure_map = {"proc-1": 401}
    offering_map = {"off-1": 501}
    station_map = {"100": 11}

    writer.upsert_timeseries(
        series,
        connector_id=1,
        service_ref="1",
        station_id_map=station_map,
        category_id_map=category_map,
        feature_id_map=feature_map,
        procedure_id_map=procedure_map,
        offering_id_map=offering_map,
        phenomenon_id_map=phenomenon_map,
    )
    ts_rows = fake.tables["timeseries"].last_upsert
    assert ts_rows[0]["timeseries_ref"] == "ts-1"
    assert ts_rows[0]["connector_id"] == 1
    assert ts_rows[0]["service_ref"] == "1"
    assert ts_rows[0]["phenomenon_id"] == list(phenomenon_map.values())[0]
    assert ts_rows[0]["station_id"] == 11
    assert ts_rows[0]["offering_id"] == 501
