from dataclasses import dataclass
from typing import Any

from scripts.uk_aq_phenomena_rpc import upsert_phenomena_via_rpc


@dataclass
class FakeResponse:
    data: list[dict[str, Any]]


class FakeCall:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    def execute(self) -> FakeResponse:
        return FakeResponse(self.rows)


class FakePublic:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.params: dict[str, Any] = {}

    def rpc(self, _name: str, params: dict[str, Any]) -> FakeCall:
        self.params = params
        return FakeCall(self.rows)


def test_shared_rpc_returns_source_mapping() -> None:
    public = FakePublic(
        [
            {
                "source_label": "source:pm25",
                "phenomenon_id": 9,
                "mapping_warning": None,
            }
        ]
    )
    result = upsert_phenomena_via_rpc(
        public,
        [{"connector_id": 1, "source_label": "source:pm25", "label": "PM2.5"}],
    )
    assert result["source:pm25"]["phenomenon_id"] == 9
    assert set(public.params) == {"rows"}


def test_shared_rpc_can_explicitly_enable_mapping_registration() -> None:
    public = FakePublic(
        [
            {
                "source_label": "source:no2",
                "phenomenon_id": 12,
                "mapping_warning": None,
            }
        ]
    )
    upsert_phenomena_via_rpc(
        public,
        [{"connector_id": 1, "source_label": "source:no2", "label": "NO2"}],
        allow_mapping_upsert=True,
    )
    assert public.params["p_allow_mapping_upsert"] is True


def test_shared_rpc_fails_closed_on_unknown_source_warning() -> None:
    public = FakePublic(
        [
            {
                "source_label": "source:new",
                "phenomenon_id": 99,
                "mapping_warning": "unknown_source_label",
            }
        ]
    )
    try:
        upsert_phenomena_via_rpc(
            public,
            [{"connector_id": 1, "source_label": "source:new", "label": "New"}],
        )
    except RuntimeError as exc:
        assert "unknown_source_label" in str(exc)
    else:
        raise AssertionError("Unknown source warning must fail closed")
