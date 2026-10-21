"""Real, event-sourced RTC connection data (Phase 9 observability), read from your backend."""

from __future__ import annotations

from typing import Any, cast

from .._async_http import AsyncSwalvoHttpClient
from .._http import SwalvoHttpClient
from .._types import ConnectionDetail, ConnectionSummary, ListConnectionsParams


def _list_query(params: ListConnectionsParams) -> dict[str, Any]:
    return {"roomId": params.room_id, "state": params.state, "limit": params.limit}


class ConnectionsResource:
    def __init__(self, http: SwalvoHttpClient) -> None:
        self._http = http

    def list(self, params: ListConnectionsParams | None = None) -> list[ConnectionSummary]:
        result = self._http.request("/v1/connections", query=_list_query(params or ListConnectionsParams()))
        return cast("list[ConnectionSummary]", result)

    def get(self, connection_id: str) -> ConnectionDetail:
        return cast(ConnectionDetail, self._http.request(f"/v1/connections/{connection_id}"))


class AsyncConnectionsResource:
    def __init__(self, http: AsyncSwalvoHttpClient) -> None:
        self._http = http

    async def list(self, params: ListConnectionsParams | None = None) -> list[ConnectionSummary]:
        result = await self._http.request("/v1/connections", query=_list_query(params or ListConnectionsParams()))
        return cast("list[ConnectionSummary]", result)

    async def get(self, connection_id: str) -> ConnectionDetail:
        return cast(ConnectionDetail, await self._http.request(f"/v1/connections/{connection_id}"))
