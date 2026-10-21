"""Swalvo's synchronous server SDK client — for your backend only, never a browser bundle.

Authenticates with a permanent project API key; never expose that key, or an
instance of this class, to a browser (Phase 10 spec Section 2).

    from swalvo import Swalvo
    swalvo = Swalvo(
        api_key=os.environ["SWALVO_API_KEY"],
        base_url=os.environ["SWALVO_API_URL"],  # https://api.livqeno.com
    )
    token = swalvo.tokens.create(CreateTokenParams(room=room_id, identity="user-42"))
"""

from __future__ import annotations

from ._http import SwalvoHttpClient
from ._http_shared import DEFAULT_BASE_URL, DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_SECONDS
from .resources.ai import AgentsResource, TranscriptionsResource
from .resources.chat import ChatResource
from .resources.connections import ConnectionsResource
from .resources.diagnostics import DiagnosticsResource
from .resources.errors import ErrorsResource
from .resources.live_streams import LiveStreamsResource
from .resources.metrics import MetricsResource
from .resources.projects import ProjectsResource
from .resources.rooms import RoomsResource
from .resources.tokens import TokensResource


class Swalvo:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ) -> None:
        http = SwalvoHttpClient(api_key=api_key, base_url=base_url, timeout=timeout, max_retries=max_retries)
        self._http = http
        self.projects = ProjectsResource(http)
        self.tokens = TokensResource(http)
        self.rooms = RoomsResource(http)
        self.connections = ConnectionsResource(http)
        self.errors = ErrorsResource(http)
        self.metrics = MetricsResource(http)
        self.diagnostics = DiagnosticsResource(http)
        self.chat = ChatResource(http)
        self.live_streams = LiveStreamsResource(http)
        self.transcriptions = TranscriptionsResource(http)
        self.agents = AgentsResource(http)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Swalvo:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()
