"""Authenticated, project-scoped diagnostics (Phase 9) — signaling/SFU/TURN
health plus this project's real active-connection count. There is no
client-side (browser ICE/signaling state) diagnostic here — that only exists
inside a running ``@swalvo/rtc`` client (``room.getDiagnostics()``), which a
backend has no way to observe.
"""

from __future__ import annotations

from typing import cast

from .._async_http import AsyncSwalvoHttpClient
from .._http import SwalvoHttpClient
from .._types import ProjectDiagnostics


class DiagnosticsResource:
    def __init__(self, http: SwalvoHttpClient) -> None:
        self._http = http

    def get(self) -> ProjectDiagnostics:
        return cast(ProjectDiagnostics, self._http.request("/v1/diagnostics"))


class AsyncDiagnosticsResource:
    def __init__(self, http: AsyncSwalvoHttpClient) -> None:
        self._http = http

    async def get(self) -> ProjectDiagnostics:
        return cast(ProjectDiagnostics, await self._http.request("/v1/diagnostics"))
