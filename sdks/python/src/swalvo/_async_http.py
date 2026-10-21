"""The async twin of ``_http.py`` — same policy (see ``_http_shared.py``), ``httpx.AsyncClient`` instead."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from ._errors import SwalvoError
from ._http_shared import (
    DEFAULT_BASE_URL,
    DEFAULT_MAX_RETRIES,
    DEFAULT_TIMEOUT_SECONDS,
    backoff_delay_seconds,
    build_headers,
    map_error_response,
    should_retry_status,
    validate_api_key,
)
from ._version import SDK_VERSION


class AsyncSwalvoHttpClient:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.__api_key = validate_api_key(api_key)
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._max_retries = max_retries
        self._client = httpx.AsyncClient(timeout=timeout, transport=transport)

    def __repr__(self) -> str:
        return f"AsyncSwalvoHttpClient({self._base_url!r})"

    async def aclose(self) -> None:
        await self._client.aclose()

    async def request(
        self,
        path: str,
        *,
        method: str = "GET",
        query: dict[str, Any] | None = None,
        body: Any = None,
        retryable: bool = True,
        text: bool = False,
    ) -> Any:
        url = f"{self._base_url}{path}"
        params = {k: v for k, v in (query or {}).items() if v is not None}
        headers = build_headers(self.__api_key, SDK_VERSION)

        attempt = 0
        while True:
            try:
                response = await self._client.request(method, url, params=params, json=body, headers=headers)
            except httpx.TimeoutException as exc:
                if retryable and attempt < self._max_retries:
                    await asyncio.sleep(backoff_delay_seconds(attempt))
                    attempt += 1
                    continue
                raise SwalvoError(f"Request timed out after {self._timeout}s", code="RAVEN_TIMEOUT") from exc
            except httpx.HTTPError as exc:
                if retryable and attempt < self._max_retries:
                    await asyncio.sleep(backoff_delay_seconds(attempt))
                    attempt += 1
                    continue
                raise SwalvoError("Could not reach the Swalvo API", code="RAVEN_NETWORK_ERROR") from exc

            request_id = response.headers.get("x-request-id")

            if response.status_code == 204:
                return None

            if text and response.is_success:
                return response.text

            try:
                payload = response.json()
            except ValueError:
                payload = None

            if response.is_success:
                return payload

            if retryable and should_retry_status(response.status_code) and attempt < self._max_retries:
                await asyncio.sleep(backoff_delay_seconds(attempt))
                attempt += 1
                continue

            raise map_error_response(response.status_code, payload, request_id)


AsyncRavenHttpClient = AsyncSwalvoHttpClient
"""Deprecated: renamed to :class:`AsyncSwalvoHttpClient`."""
