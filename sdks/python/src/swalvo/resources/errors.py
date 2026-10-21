"""Classified RTC errors — never a raw SFU or coturn error code. See docs/error-codes.md."""

from __future__ import annotations

from typing import Any, cast

from .._async_http import AsyncSwalvoHttpClient
from .._http import SwalvoHttpClient
from .._types import ErrorDetail, ErrorSummary, ListErrorsParams


def _list_query(params: ListErrorsParams) -> dict[str, Any]:
    return {"category": params.category, "connectionId": params.connection_id, "limit": params.limit}


class ErrorsResource:
    def __init__(self, http: SwalvoHttpClient) -> None:
        self._http = http

    def list(self, params: ListErrorsParams | None = None) -> list[ErrorSummary]:
        result = self._http.request("/v1/errors", query=_list_query(params or ListErrorsParams()))
        return cast("list[ErrorSummary]", result)

    def get(self, error_id: str) -> ErrorDetail:
        return cast(ErrorDetail, self._http.request(f"/v1/errors/{error_id}"))


class AsyncErrorsResource:
    def __init__(self, http: AsyncSwalvoHttpClient) -> None:
        self._http = http

    async def list(self, params: ListErrorsParams | None = None) -> list[ErrorSummary]:
        result = await self._http.request("/v1/errors", query=_list_query(params or ListErrorsParams()))
        return cast("list[ErrorSummary]", result)

    async def get(self, error_id: str) -> ErrorDetail:
        return cast(ErrorDetail, await self._http.request(f"/v1/errors/{error_id}"))
