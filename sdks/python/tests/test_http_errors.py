from __future__ import annotations

import httpx
import pytest

from swalvo._errors import SwalvoError
from swalvo._http import SwalvoHttpClient


def test_network_error_maps_to_swalvo_error_after_exhausting_retries() -> None:
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        raise httpx.ConnectError("connection refused", request=request)

    client = SwalvoHttpClient(api_key="k", transport=httpx.MockTransport(handler), max_retries=2)

    with pytest.raises(SwalvoError) as exc_info:
        client.request("/v1/rooms")

    assert exc_info.value.code == "RAVEN_NETWORK_ERROR"
    assert calls["count"] == 3  # initial + 2 retries


def test_timeout_maps_to_swalvo_error_and_never_hangs() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)

    client = SwalvoHttpClient(api_key="k", transport=httpx.MockTransport(handler), max_retries=0, timeout=0.01)

    with pytest.raises(SwalvoError) as exc_info:
        client.request("/v1/rooms")

    assert exc_info.value.code == "RAVEN_TIMEOUT"
