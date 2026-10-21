"""Swalvo's async server SDK client — same surface as ``Swalvo``, awaited.

from swalvo import AsyncSwalvo
swalvo = AsyncSwalvo(
    api_key=os.environ["SWALVO_API_KEY"],
    base_url=os.environ["SWALVO_API_URL"],  # https://api.swalvo.com
)
token = await swalvo.tokens.create(CreateTokenParams(room=room_id, identity="user-42"))
"""

from __future__ import annotations

from ._async_http import AsyncSwalvoHttpClient
from ._http_shared import DEFAULT_BASE_URL, DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_SECONDS
from .resources.ai import AsyncAgentsResource, AsyncTranscriptionsResource
from .resources.chat import AsyncChatResource
from .resources.connections import AsyncConnectionsResource
from .resources.diagnostics import AsyncDiagnosticsResource
from .resources.errors import AsyncErrorsResource
from .resources.live_streams import AsyncLiveStreamsResource
from .resources.metrics import AsyncMetricsResource
from .resources.projects import AsyncProjectsResource
from .resources.rooms import AsyncRoomsResource
from .resources.tokens import AsyncTokensResource


class AsyncSwalvo:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ) -> None:
        http = AsyncSwalvoHttpClient(api_key=api_key, base_url=base_url, timeout=timeout, max_retries=max_retries)
        self._http = http
        self.projects = AsyncProjectsResource(http)
        self.tokens = AsyncTokensResource(http)
        self.rooms = AsyncRoomsResource(http)
        self.connections = AsyncConnectionsResource(http)
        self.errors = AsyncErrorsResource(http)
        self.metrics = AsyncMetricsResource(http)
        self.diagnostics = AsyncDiagnosticsResource(http)
        self.chat = AsyncChatResource(http)
        self.live_streams = AsyncLiveStreamsResource(http)
        self.transcriptions = AsyncTranscriptionsResource(http)
        self.agents = AsyncAgentsResource(http)

    async def close(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> AsyncSwalvo:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.close()
