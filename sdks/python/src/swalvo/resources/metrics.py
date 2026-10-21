"""Real-only aggregate metrics (Phase 9) — this is also today's "usage" view
(no separate billing/usage-metering system exists yet, see
docs/sdk/server/python.md#usage).
"""

from __future__ import annotations

from typing import cast

from .._async_http import AsyncSwalvoHttpClient
from .._http import SwalvoHttpClient
from .._types import MetricsOverview, MetricsRange


class MetricsResource:
    def __init__(self, http: SwalvoHttpClient) -> None:
        self._http = http

    def get(self, range: MetricsRange | None = None) -> MetricsOverview:
        return cast(MetricsOverview, self._http.request("/v1/metrics", query={"range": range}))


class AsyncMetricsResource:
    def __init__(self, http: AsyncSwalvoHttpClient) -> None:
        self._http = http

    async def get(self, range: MetricsRange | None = None) -> MetricsOverview:
        return cast(MetricsOverview, await self._http.request("/v1/metrics", query={"range": range}))
