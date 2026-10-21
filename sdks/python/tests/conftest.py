from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest


@pytest.fixture
def mock_transport() -> Callable[[list[dict[str, Any]]], httpx.MockTransport]:
    """Builds an httpx.MockTransport that replays a fixed sequence of responses.

    Each item is {"status": int, "body": Any, "headers": dict[str, str]}.
    """

    def _build(responses: list[dict[str, Any]]) -> httpx.MockTransport:
        state = {"calls": []}
        iterator = iter(responses)

        def handler(request: httpx.Request) -> httpx.Response:
            state["calls"].append(request)
            item = next(iterator)
            body = item.get("body")
            content = b"" if body is None else json.dumps(body).encode()
            return httpx.Response(item["status"], content=content, headers=item.get("headers", {}))

        transport = httpx.MockTransport(handler)
        transport.calls = state["calls"]  # type: ignore[attr-defined]
        return transport

    return _build
