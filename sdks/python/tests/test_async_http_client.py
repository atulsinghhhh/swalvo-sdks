from __future__ import annotations

import json

import httpx
import pytest

from swalvo._async_http import AsyncSwalvoHttpClient
from swalvo._errors import SwalvoError

pytestmark = pytest.mark.asyncio


def _transport(responses: list[dict]) -> httpx.MockTransport:
    calls: list[httpx.Request] = []
    iterator = iter(responses)

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        item = next(iterator)
        body = item.get("body")
        content = b"" if body is None else json.dumps(body).encode()
        return httpx.Response(item["status"], content=content, headers=item.get("headers", {}))

    t = httpx.MockTransport(handler)
    t.calls = calls  # type: ignore[attr-defined]
    return t


async def test_async_client_sends_auth_header() -> None:
    transport = _transport([{"status": 200, "body": []}])
    client = AsyncSwalvoHttpClient(api_key="rvk_abc.secret", transport=transport)

    await client.request("/v1/rooms")

    assert transport.calls[0].headers["authorization"] == "Bearer rvk_abc.secret"
    await client.aclose()


async def test_async_client_retries_503_then_succeeds() -> None:
    transport = _transport(
        [{"status": 503, "body": {"message": "unavailable"}}, {"status": 200, "body": [{"id": "r1"}]}]
    )
    client = AsyncSwalvoHttpClient(api_key="k", transport=transport)

    result = await client.request("/v1/rooms")

    assert result == [{"id": "r1"}]
    assert len(transport.calls) == 2
    await client.aclose()


async def test_async_client_never_retries_404() -> None:
    transport = _transport([{"status": 404, "body": {"message": "not found"}}])
    client = AsyncSwalvoHttpClient(api_key="k", transport=transport)

    with pytest.raises(SwalvoError) as exc_info:
        await client.request("/v1/rooms/missing")

    assert exc_info.value.status_code == 404
    assert len(transport.calls) == 1
    await client.aclose()


async def test_async_client_network_error_after_retries() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    client = AsyncSwalvoHttpClient(api_key="k", transport=httpx.MockTransport(handler), max_retries=1)

    with pytest.raises(SwalvoError) as exc_info:
        await client.request("/v1/rooms")
    assert exc_info.value.code == "RAVEN_NETWORK_ERROR"
    await client.aclose()


async def test_async_client_secret_never_in_repr() -> None:
    client = AsyncSwalvoHttpClient(api_key="rvk_super-secret.dontleakme", transport=_transport([]))
    assert "dontleakme" not in repr(client)
    await client.aclose()
