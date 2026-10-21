"""Live transcription and AI voice agents (phase6-contracts.md §3).

Customer provider keys (``provider_keys``) go to the worker for that one job
only; Swalvo never stores or logs them.
"""

from __future__ import annotations

import builtins
from typing import Any, cast
from urllib.parse import quote

from .._async_http import AsyncSwalvoHttpClient
from .._http import SwalvoHttpClient


def _q(value: str) -> str:
    return quote(value, safe="")


def _transcription_body(
    language: str | None,
    provider: str | None,
    model: str | None,
    participants: list[str] | None,
    interim_results: bool | None,
    profanity_filter: bool | None,
    persist: bool | None,
    provider_keys: dict[str, str] | None,
) -> dict[str, Any]:
    fields = {
        "language": language,
        "provider": provider,
        "model": model,
        "participants": participants,
        "interimResults": interim_results,
        "profanityFilter": profanity_filter,
        "persist": persist,
        "providerKeys": provider_keys,
    }
    return {k: v for k, v in fields.items() if v is not None}


class TranscriptionsResource:
    def __init__(self, http: SwalvoHttpClient) -> None:
        self._http = http

    def start(
        self,
        room_id: str,
        *,
        language: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        participants: list[str] | None = None,
        interim_results: bool | None = None,
        profanity_filter: bool | None = None,
        persist: bool | None = None,
        provider_keys: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        body = _transcription_body(
            language, provider, model, participants, interim_results, profanity_filter, persist, provider_keys
        )
        return cast(
            "dict[str, Any]",
            self._http.request(f"/v1/rooms/{_q(room_id)}/transcription", method="POST", body=body, retryable=False),
        )

    def get(self, room_id: str) -> dict[str, Any]:
        return cast("dict[str, Any]", self._http.request(f"/v1/rooms/{_q(room_id)}/transcription"))

    def stop(self, room_id: str) -> None:
        self._http.request(f"/v1/rooms/{_q(room_id)}/transcription", method="DELETE")

    def transcript(
        self, transcription_id: str, *, cursor: str | None = None, limit: int | None = None
    ) -> dict[str, Any]:
        return cast(
            "dict[str, Any]",
            self._http.request(f"/v1/transcripts/{_q(transcription_id)}", query={"cursor": cursor, "limit": limit}),
        )

    def export(self, transcription_id: str, fmt: str = "vtt") -> str:
        """``fmt`` is ``"vtt"`` (WebVTT) or ``"txt"``."""
        if fmt not in ("vtt", "txt"):
            raise ValueError('fmt must be "vtt" or "txt"')
        return cast(str, self._http.request(f"/v1/transcripts/{_q(transcription_id)}.{fmt}", text=True))

    def erase_participant(self, identity: str) -> dict[str, Any]:
        """GDPR: delete every stored segment this participant identity spoke."""
        return cast(
            "dict[str, Any]", self._http.request(f"/v1/transcripts/participants/{_q(identity)}", method="DELETE")
        )


class AgentsResource:
    def __init__(self, http: SwalvoHttpClient) -> None:
        self._http = http

    def create(self, room_id: str, params: dict[str, Any]) -> dict[str, Any]:
        """``params`` is the §3.2 body in its wire shape (``name``, ``instructions``,
        ``llm``, ``stt``, ``tts``, ``tools``, ``providerKeys``, ...)."""
        return cast(
            "dict[str, Any]",
            self._http.request(f"/v1/rooms/{_q(room_id)}/agents", method="POST", body=params, retryable=False),
        )

    def list(self, room_id: str) -> list[dict[str, Any]]:
        return cast("list[dict[str, Any]]", self._http.request(f"/v1/rooms/{_q(room_id)}/agents"))

    def get(self, agent_id: str) -> dict[str, Any]:
        return cast("dict[str, Any]", self._http.request(f"/v1/agents/{_q(agent_id)}"))

    def update(
        self,
        agent_id: str,
        *,
        instructions: str | None = None,
        listen_to: builtins.list[str] | None = None,
        interruptible: bool | None = None,
    ) -> dict[str, Any]:
        fields = {"instructions": instructions, "listenTo": listen_to, "interruptible": interruptible}
        body = {k: v for k, v in fields.items() if v is not None}
        return cast("dict[str, Any]", self._http.request(f"/v1/agents/{_q(agent_id)}", method="PATCH", body=body))

    def say(self, agent_id: str, text: str) -> None:
        self._http.request(f"/v1/agents/{_q(agent_id)}/say", method="POST", body={"text": text}, retryable=False)

    def interrupt(self, agent_id: str) -> None:
        self._http.request(f"/v1/agents/{_q(agent_id)}/interrupt", method="POST")

    def delete(self, agent_id: str) -> None:
        self._http.request(f"/v1/agents/{_q(agent_id)}", method="DELETE")


class AsyncTranscriptionsResource:
    def __init__(self, http: AsyncSwalvoHttpClient) -> None:
        self._http = http

    async def start(
        self,
        room_id: str,
        *,
        language: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        participants: list[str] | None = None,
        interim_results: bool | None = None,
        profanity_filter: bool | None = None,
        persist: bool | None = None,
        provider_keys: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        body = _transcription_body(
            language, provider, model, participants, interim_results, profanity_filter, persist, provider_keys
        )
        return cast(
            "dict[str, Any]",
            await self._http.request(
                f"/v1/rooms/{_q(room_id)}/transcription", method="POST", body=body, retryable=False
            ),
        )

    async def get(self, room_id: str) -> dict[str, Any]:
        return cast("dict[str, Any]", await self._http.request(f"/v1/rooms/{_q(room_id)}/transcription"))

    async def stop(self, room_id: str) -> None:
        await self._http.request(f"/v1/rooms/{_q(room_id)}/transcription", method="DELETE")

    async def transcript(
        self, transcription_id: str, *, cursor: str | None = None, limit: int | None = None
    ) -> dict[str, Any]:
        return cast(
            "dict[str, Any]",
            await self._http.request(
                f"/v1/transcripts/{_q(transcription_id)}", query={"cursor": cursor, "limit": limit}
            ),
        )

    async def export(self, transcription_id: str, fmt: str = "vtt") -> str:
        if fmt not in ("vtt", "txt"):
            raise ValueError('fmt must be "vtt" or "txt"')
        return cast(str, await self._http.request(f"/v1/transcripts/{_q(transcription_id)}.{fmt}", text=True))

    async def erase_participant(self, identity: str) -> dict[str, Any]:
        return cast(
            "dict[str, Any]", await self._http.request(f"/v1/transcripts/participants/{_q(identity)}", method="DELETE")
        )


class AsyncAgentsResource:
    def __init__(self, http: AsyncSwalvoHttpClient) -> None:
        self._http = http

    async def create(self, room_id: str, params: dict[str, Any]) -> dict[str, Any]:
        return cast(
            "dict[str, Any]",
            await self._http.request(f"/v1/rooms/{_q(room_id)}/agents", method="POST", body=params, retryable=False),
        )

    async def list(self, room_id: str) -> list[dict[str, Any]]:
        return cast("list[dict[str, Any]]", await self._http.request(f"/v1/rooms/{_q(room_id)}/agents"))

    async def get(self, agent_id: str) -> dict[str, Any]:
        return cast("dict[str, Any]", await self._http.request(f"/v1/agents/{_q(agent_id)}"))

    async def update(
        self,
        agent_id: str,
        *,
        instructions: str | None = None,
        listen_to: builtins.list[str] | None = None,
        interruptible: bool | None = None,
    ) -> dict[str, Any]:
        fields = {"instructions": instructions, "listenTo": listen_to, "interruptible": interruptible}
        body = {k: v for k, v in fields.items() if v is not None}
        return cast("dict[str, Any]", await self._http.request(f"/v1/agents/{_q(agent_id)}", method="PATCH", body=body))

    async def say(self, agent_id: str, text: str) -> None:
        await self._http.request(f"/v1/agents/{_q(agent_id)}/say", method="POST", body={"text": text}, retryable=False)

    async def interrupt(self, agent_id: str) -> None:
        await self._http.request(f"/v1/agents/{_q(agent_id)}/interrupt", method="POST")

    async def delete(self, agent_id: str) -> None:
        await self._http.request(f"/v1/agents/{_q(agent_id)}", method="DELETE")
