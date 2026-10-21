"""An API key is already permanently scoped to exactly one project (Phase 10
spec Section 2/14) — there is nothing to list/create/update/delete here.
Those remain human/dashboard-session operations, not something a server API
key can or should do. ``get()`` takes no arguments: it always returns the one
project this key belongs to.
"""

from __future__ import annotations

from typing import cast

from .._async_http import AsyncSwalvoHttpClient
from .._http import SwalvoHttpClient
from .._types import Project


class ProjectsResource:
    def __init__(self, http: SwalvoHttpClient) -> None:
        self._http = http

    def get(self) -> Project:
        return cast(Project, self._http.request("/v1/project"))


class AsyncProjectsResource:
    def __init__(self, http: AsyncSwalvoHttpClient) -> None:
        self._http = http

    async def get(self) -> Project:
        return cast(Project, await self._http.request("/v1/project"))
