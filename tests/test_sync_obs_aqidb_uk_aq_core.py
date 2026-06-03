import json
from typing import Any, Dict, List

import pytest
import requests

from scripts.stations_daily import sync_obs_aqidb_uk_aq_core as sync_mod


class FakeResponse:
    def __init__(
        self,
        *,
        status_code: int = 200,
        json_data: Any = None,
        text: str = "",
        reason: str = "OK",
    ) -> None:
        self.status_code = status_code
        self._json_data = json_data
        self.text = text
        self.reason = reason
        self.ok = 200 <= status_code < 400
        self.headers: Dict[str, str] = {}

    def json(self) -> Any:
        return self._json_data


def make_client() -> sync_mod.PostgrestClient:
    return sync_mod.PostgrestClient(
        base_url="https://example.test",
        secret_key="secret",
        caller="caller",
        project_label="source",
    )


def patch_retry_helpers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sync_mod.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(sync_mod.random, "uniform", lambda _a, _b: 0.0)


def test_request_json_retries_ssl_error_then_success(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client()
    patch_retry_helpers(monkeypatch)
    calls: List[Dict[str, Any]] = []

    def fake_request(*, method, url, headers, params, json, timeout):
        calls.append({"method": method, "url": url, "params": params, "timeout": timeout})
        if len(calls) == 1:
            raise requests.exceptions.SSLError("EOF while reading")
        return FakeResponse(json_data=[{"id": 1}], text='[{"id":1}]')

    monkeypatch.setattr(sync_mod.requests, "request", fake_request)

    result = client.request_json(
        "GET",
        "/rest/v1/stations",
        profile="uk_aq_core",
        params={"select": "*"},
    )

    assert result == [{"id": 1}]
    assert len(calls) == 2


def test_request_json_retries_timeout_then_success(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client()
    patch_retry_helpers(monkeypatch)
    calls: List[Dict[str, Any]] = []

    def fake_request(*, method, url, headers, params, json, timeout):
        calls.append({"method": method, "url": url, "params": params, "timeout": timeout})
        if len(calls) == 1:
            raise requests.exceptions.Timeout("timed out")
        return FakeResponse(json_data=[{"id": 2}], text='[{"id":2}]')

    monkeypatch.setattr(sync_mod.requests, "request", fake_request)

    result = client.request_json(
        "GET",
        "/rest/v1/stations",
        profile="uk_aq_core",
        params={"select": "*"},
    )

    assert result == [{"id": 2}]
    assert len(calls) == 2


def test_request_json_retries_http_503_then_success(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client()
    patch_retry_helpers(monkeypatch)
    calls: List[Dict[str, Any]] = []

    def fake_request(*, method, url, headers, params, json, timeout):
        calls.append({"method": method, "url": url, "params": params, "timeout": timeout})
        if len(calls) == 1:
            return FakeResponse(status_code=503, text="Service unavailable", reason="Service Unavailable")
        return FakeResponse(json_data=[{"id": 3}], text='[{"id":3}]')

    monkeypatch.setattr(sync_mod.requests, "request", fake_request)

    result = client.request_json(
        "GET",
        "/rest/v1/stations",
        profile="uk_aq_core",
        params={"select": "*"},
    )

    assert result == [{"id": 3}]
    assert len(calls) == 2


def test_request_json_fails_fast_on_http_400(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client()
    patch_retry_helpers(monkeypatch)
    calls: List[Dict[str, Any]] = []

    def fake_request(*, method, url, headers, params, json, timeout):
        calls.append({"method": method, "url": url, "params": params, "timeout": timeout})
        return FakeResponse(status_code=400, text='{"error":"bad request"}', reason="Bad Request")

    monkeypatch.setattr(sync_mod.requests, "request", fake_request)

    with pytest.raises(sync_mod.SyncError, match=r"400"):
        client.request_json(
            "GET",
            "/rest/v1/stations",
            profile="uk_aq_core",
            params={"select": "*"},
        )

    assert len(calls) == 1


def test_request_json_retries_exhausted_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client()
    patch_retry_helpers(monkeypatch)
    calls: List[Dict[str, Any]] = []

    def fake_request(*, method, url, headers, params, json, timeout):
        calls.append({"method": method, "url": url, "params": params, "timeout": timeout})
        return FakeResponse(status_code=503, text="Service unavailable", reason="Service Unavailable")

    monkeypatch.setattr(sync_mod.requests, "request", fake_request)

    with pytest.raises(sync_mod.SyncError, match=r"failed after 5 attempts"):
        client.request_json(
            "GET",
            "/rest/v1/stations",
            profile="uk_aq_core",
            params={"select": "*"},
        )

    assert len(calls) == sync_mod.RETRY_MAX_ATTEMPTS


def test_fetch_all_rows_retries_middle_page_and_continues(monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client()
    patch_retry_helpers(monkeypatch)
    calls: List[Dict[str, Any]] = []

    responses = [
        FakeResponse(json_data=[{"id": 1}, {"id": 2}], text=json.dumps([{"id": 1}, {"id": 2}])),
        requests.exceptions.ConnectionError("temporary disconnect"),
        FakeResponse(json_data=[{"id": 3}, {"id": 4}], text=json.dumps([{"id": 3}, {"id": 4}])),
        FakeResponse(json_data=[{"id": 5}], text=json.dumps([{"id": 5}])),
    ]

    def fake_request(*, method, url, headers, params, json, timeout):
        calls.append({"method": method, "url": url, "params": dict(params or {}), "timeout": timeout})
        item = responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr(sync_mod.requests, "request", fake_request)

    rows = client.fetch_all_rows(
        "stations",
        profile="uk_aq_core",
        select="*",
        order="id.asc",
        page_size=2,
    )

    assert [row["id"] for row in rows] == [1, 2, 3, 4, 5]
    assert len(calls) == 4
    assert calls[0]["params"]["offset"] == "0"
    assert calls[1]["params"]["offset"] == "2"
    assert calls[2]["params"]["offset"] == "2"
    assert calls[3]["params"]["offset"] == "4"
