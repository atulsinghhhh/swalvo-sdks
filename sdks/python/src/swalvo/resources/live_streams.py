"""Swalvo Live Streaming, server-side (Phase 14). A stream composes an RTC
room and a chat conversation — this resource only owns lifecycle and role
bookkeeping on top of them, the same reuse discipline the backend itself
follows.

``add_host()``/``create_viewer_token()`` are the security-critical methods:
the role your caller ends up with is entirely determined by which method
you call, never by a field the request body accepts. A viewer token is
always subscribe-only; there is no way to ask this SDK for anything else —
``add_host()`` (called from your own backend, after your own auth check) is
the only path to publish access.
"""

from __future__ import annotations

from typing import Any, cast

from .._async_http import AsyncSwalvoHttpClient
from .._http import SwalvoHttpClient
from .._types import (
    AddHostParams,
    CreateIngressParams,
    CreateLiveStreamParams,
    CreateRestreamParams,
    IngressView,
    IngressWithKey,
    IssuedStreamCredential,
    LiveStream,
    LiveStreamStatus,
    RestreamView,
    UpdateLiveStreamParams,
    UpdateRestreamParams,
)


def _drop_none(payload: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if value is not None}


def _viewer_body(identity: str, accept_playback: bool) -> dict[str, Any]:
    return {"identity": identity, "acceptPlayback": True} if accept_playback else {"identity": identity}


def _create_body(params: CreateLiveStreamParams) -> dict[str, Any]:
    return _drop_none(
        {
            "title": params.title,
            "hostIdentity": params.host_identity,
            "description": params.description,
            "thumbnailUrl": params.thumbnail_url,
            "category": params.category,
            "tags": params.tags,
            "language": params.language,
            "visibility": params.visibility,
            "metadata": params.metadata,
            "scheduledAt": params.scheduled_at,
            "deliveryMode": params.delivery_mode,
            "edgeScaling": params.edge_scaling,
        }
    )


def _update_body(params: UpdateLiveStreamParams) -> dict[str, Any]:
    return _drop_none(
        {
            "title": params.title,
            "description": params.description,
            "thumbnailUrl": params.thumbnail_url,
            "category": params.category,
            "tags": params.tags,
            "language": params.language,
            "visibility": params.visibility,
            "metadata": params.metadata,
        }
    )


def _host_body(params: AddHostParams) -> dict[str, Any]:
    return _drop_none({"identity": params.identity, "role": params.role})


def _restream_create_body(params: CreateRestreamParams) -> dict[str, Any]:
    return _drop_none({"url": params.url, "streamKey": params.stream_key, "label": params.label})


def _restream_update_body(params: UpdateRestreamParams) -> dict[str, Any]:
    return _drop_none({"enabled": params.enabled, "label": params.label})


def _ingress_create_body(params: CreateIngressParams | None) -> dict[str, Any]:
    if params is None:
        return {}
    return _drop_none(
        {
            "protocol": params.protocol,
            "identity": params.identity,
            "autoStart": params.auto_start,
            "reconnectWindowSec": params.reconnect_window_sec,
        }
    )


class LiveStreamRestreamsResource:
    """Restream ("RTMP out"): push a live stream to up to 5 RTMP/RTMPS destinations.

    Destinations can be added, paused and removed while the stream is LIVE.
    One destination failing never affects HLS or the other destinations — it
    retries with backoff, then lands in ``FAILED`` and fires
    ``live_stream.restream_failed``. The destination's stream key is encrypted
    at rest and never returned (only ``keyLast4``); to change a key, delete the
    destination and create it again.
    """

    def __init__(self, http: SwalvoHttpClient) -> None:
        self._http = http

    def create(self, stream_id: str, params: CreateRestreamParams) -> RestreamView:
        """Adds a destination. If the stream is LIVE, pushing starts immediately."""
        result = self._http.request(
            f"/v1/live-streams/{stream_id}/restreams", method="POST", body=_restream_create_body(params)
        )
        return cast(RestreamView, result)

    def list(self, stream_id: str) -> list[RestreamView]:
        return cast("list[RestreamView]", self._http.request(f"/v1/live-streams/{stream_id}/restreams"))

    def update(self, stream_id: str, restream_id: str, params: UpdateRestreamParams) -> RestreamView:
        """``enabled=False`` pauses one destination mid-stream; ``True`` resumes it."""
        result = self._http.request(
            f"/v1/live-streams/{stream_id}/restreams/{restream_id}",
            method="PATCH",
            body=_restream_update_body(params),
        )
        return cast(RestreamView, result)

    def delete(self, stream_id: str, restream_id: str) -> None:
        """Stops pushing to the destination and removes it."""
        self._http.request(f"/v1/live-streams/{stream_id}/restreams/{restream_id}", method="DELETE")


class AsyncLiveStreamRestreamsResource:
    def __init__(self, http: AsyncSwalvoHttpClient) -> None:
        self._http = http

    async def create(self, stream_id: str, params: CreateRestreamParams) -> RestreamView:
        result = await self._http.request(
            f"/v1/live-streams/{stream_id}/restreams", method="POST", body=_restream_create_body(params)
        )
        return cast(RestreamView, result)

    async def list(self, stream_id: str) -> list[RestreamView]:
        return cast("list[RestreamView]", await self._http.request(f"/v1/live-streams/{stream_id}/restreams"))

    async def update(self, stream_id: str, restream_id: str, params: UpdateRestreamParams) -> RestreamView:
        result = await self._http.request(
            f"/v1/live-streams/{stream_id}/restreams/{restream_id}",
            method="PATCH",
            body=_restream_update_body(params),
        )
        return cast(RestreamView, result)

    async def delete(self, stream_id: str, restream_id: str) -> None:
        await self._http.request(f"/v1/live-streams/{stream_id}/restreams/{restream_id}", method="DELETE")


class LiveStreamIngressResource:
    """Ingest: broadcast into a stream from OBS, vMix, ffmpeg or a hardware encoder. One ingest per stream.

    The encoder joins the room as an ordinary host (by default the stream's
    HOST identity, so it replaces a browser host on that identity). The stream
    key (``sk_...``) is the RTMP stream key and the WHIP bearer token; it is
    stored only as a hash and returned only by ``create()`` and ``reset()``.
    """

    def __init__(self, http: SwalvoHttpClient) -> None:
        self._http = http

    def create(self, stream_id: str, params: CreateIngressParams | None = None) -> IngressWithKey:
        """Creates the stream's ingest and returns its URLs plus the stream key — shown this once."""
        result = self._http.request(
            f"/v1/live-streams/{stream_id}/ingress", method="POST", body=_ingress_create_body(params)
        )
        return cast(IngressWithKey, result)

    def get(self, stream_id: str) -> IngressView:
        """Current status and observed input. Never includes the stream key."""
        return cast(IngressView, self._http.request(f"/v1/live-streams/{stream_id}/ingress"))

    def reset(self, stream_id: str) -> IngressWithKey:
        """Rotates the stream key and disconnects any connected encoder. The old key stops working immediately."""
        return cast(IngressWithKey, self._http.request(f"/v1/live-streams/{stream_id}/ingress/reset", method="POST"))

    def delete(self, stream_id: str) -> None:
        """Deletes the ingest and disconnects any connected encoder. The stream itself keeps running."""
        self._http.request(f"/v1/live-streams/{stream_id}/ingress", method="DELETE")


class AsyncLiveStreamIngressResource:
    def __init__(self, http: AsyncSwalvoHttpClient) -> None:
        self._http = http

    async def create(self, stream_id: str, params: CreateIngressParams | None = None) -> IngressWithKey:
        result = await self._http.request(
            f"/v1/live-streams/{stream_id}/ingress", method="POST", body=_ingress_create_body(params)
        )
        return cast(IngressWithKey, result)

    async def get(self, stream_id: str) -> IngressView:
        return cast(IngressView, await self._http.request(f"/v1/live-streams/{stream_id}/ingress"))

    async def reset(self, stream_id: str) -> IngressWithKey:
        result = await self._http.request(f"/v1/live-streams/{stream_id}/ingress/reset", method="POST")
        return cast(IngressWithKey, result)

    async def delete(self, stream_id: str) -> None:
        await self._http.request(f"/v1/live-streams/{stream_id}/ingress", method="DELETE")


class LiveStreamsResource:
    def __init__(self, http: SwalvoHttpClient) -> None:
        self._http = http
        self.restreams = LiveStreamRestreamsResource(http)
        """RTMP/RTMPS destinations (YouTube, Twitch, ...) a stream is pushed to."""
        self.ingress = LiveStreamIngressResource(http)
        """The stream's ingest endpoint for OBS and other encoders, over WHIP or RTMP/RTMPS."""

    def create(self, params: CreateLiveStreamParams) -> LiveStream:
        result = self._http.request("/v1/live-streams", method="POST", body=_create_body(params))
        return cast(LiveStream, result)

    def list(self, status: LiveStreamStatus | None = None) -> list[LiveStream]:
        query = _drop_none({"status": status})
        return cast("list[LiveStream]", self._http.request("/v1/live-streams", query=query))

    def get(self, stream_id: str) -> LiveStream:
        """Includes the stream's live viewer count — ``list()`` does not, to avoid one SFU round trip per row."""
        return cast(LiveStream, self._http.request(f"/v1/live-streams/{stream_id}"))

    def update(self, stream_id: str, params: UpdateLiveStreamParams) -> LiveStream:
        result = self._http.request(f"/v1/live-streams/{stream_id}", method="PATCH", body=_update_body(params))
        return cast(LiveStream, result)

    def start(self, stream_id: str) -> LiveStream:
        """CREATED -> LIVE."""
        return cast(LiveStream, self._http.request(f"/v1/live-streams/{stream_id}/start", method="POST"))

    def end(self, stream_id: str) -> LiveStream:
        """LIVE -> ENDED, terminal. An ended stream cannot be restarted — create a new one."""
        return cast(LiveStream, self._http.request(f"/v1/live-streams/{stream_id}/end", method="POST"))

    def add_host(self, stream_id: str, params: AddHostParams) -> IssuedStreamCredential:
        """Registers a host/co-host and mints full-publish RTC + moderator-or-above chat credentials in one call.

        Call again with the same identity to re-mint fresh credentials.
        """
        result = self._http.request(f"/v1/live-streams/{stream_id}/hosts", method="POST", body=_host_body(params))
        return cast(IssuedStreamCredential, result)

    def remove_host(self, stream_id: str, identity: str) -> None:
        """Soft removal — the host's chat history in the stream is preserved."""
        self._http.request(f"/v1/live-streams/{stream_id}/hosts/{identity}", method="DELETE")

    def create_viewer_token(
        self, stream_id: str, identity: str, *, accept_playback: bool = False
    ) -> IssuedStreamCredential:
        """Always subscribe-only on RTC and MEMBER on chat — see the module doc.

        ``accept_playback=True``: a BROADCAST stream returns a playback credential
        (chat + ``playback.url``) instead of a 409, so one call serves every delivery mode.
        """
        result = self._http.request(
            f"/v1/live-streams/{stream_id}/viewer-tokens", method="POST", body=_viewer_body(identity, accept_playback)
        )
        return cast(IssuedStreamCredential, result)

    def invite_to_stage(self, stream_id: str, identity: str) -> None:
        """Announces a stage invite to the viewer's client (a ``stage`` event). Changes no permissions."""
        self._http.request(f"/v1/live-streams/{stream_id}/stage/invites", method="POST", body={"identity": identity})

    def promote_to_stage(self, stream_id: str, identity: str, role: str | None = None) -> IssuedStreamCredential:
        """Brings a viewer on stage as a co-host; returns host credentials for their client's ``switchRole()``."""
        body: dict[str, Any] = {"identity": identity}
        if role is not None:
            body["role"] = role
        result = self._http.request(f"/v1/live-streams/{stream_id}/stage/promote", method="POST", body=body)
        return cast(IssuedStreamCredential, result)

    def demote_from_stage(self, stream_id: str, identity: str) -> None:
        """Takes a co-host off stage; their publishing stops at once."""
        self._http.request(f"/v1/live-streams/{stream_id}/stage/demote", method="POST", body={"identity": identity})

    def leave(self, stream_id: str, identity: str) -> None:
        """A clean-leave signal for ``live_stream.viewer_left``, not a disconnect detector.

        Swalvo has no way to observe an abrupt viewer disconnect in this phase.
        """
        self._http.request(f"/v1/live-streams/{stream_id}/leave", method="POST", body={"identity": identity})


class AsyncLiveStreamsResource:
    def __init__(self, http: AsyncSwalvoHttpClient) -> None:
        self._http = http
        self.restreams = AsyncLiveStreamRestreamsResource(http)
        self.ingress = AsyncLiveStreamIngressResource(http)

    async def create(self, params: CreateLiveStreamParams) -> LiveStream:
        result = await self._http.request("/v1/live-streams", method="POST", body=_create_body(params))
        return cast(LiveStream, result)

    async def list(self, status: LiveStreamStatus | None = None) -> list[LiveStream]:
        query = _drop_none({"status": status})
        return cast("list[LiveStream]", await self._http.request("/v1/live-streams", query=query))

    async def get(self, stream_id: str) -> LiveStream:
        return cast(LiveStream, await self._http.request(f"/v1/live-streams/{stream_id}"))

    async def update(self, stream_id: str, params: UpdateLiveStreamParams) -> LiveStream:
        result = await self._http.request(f"/v1/live-streams/{stream_id}", method="PATCH", body=_update_body(params))
        return cast(LiveStream, result)

    async def start(self, stream_id: str) -> LiveStream:
        return cast(LiveStream, await self._http.request(f"/v1/live-streams/{stream_id}/start", method="POST"))

    async def end(self, stream_id: str) -> LiveStream:
        return cast(LiveStream, await self._http.request(f"/v1/live-streams/{stream_id}/end", method="POST"))

    async def add_host(self, stream_id: str, params: AddHostParams) -> IssuedStreamCredential:
        result = await self._http.request(f"/v1/live-streams/{stream_id}/hosts", method="POST", body=_host_body(params))
        return cast(IssuedStreamCredential, result)

    async def remove_host(self, stream_id: str, identity: str) -> None:
        await self._http.request(f"/v1/live-streams/{stream_id}/hosts/{identity}", method="DELETE")

    async def create_viewer_token(
        self, stream_id: str, identity: str, *, accept_playback: bool = False
    ) -> IssuedStreamCredential:
        result = await self._http.request(
            f"/v1/live-streams/{stream_id}/viewer-tokens", method="POST", body=_viewer_body(identity, accept_playback)
        )
        return cast(IssuedStreamCredential, result)

    async def invite_to_stage(self, stream_id: str, identity: str) -> None:
        await self._http.request(
            f"/v1/live-streams/{stream_id}/stage/invites", method="POST", body={"identity": identity}
        )

    async def promote_to_stage(self, stream_id: str, identity: str, role: str | None = None) -> IssuedStreamCredential:
        body: dict[str, Any] = {"identity": identity}
        if role is not None:
            body["role"] = role
        result = await self._http.request(f"/v1/live-streams/{stream_id}/stage/promote", method="POST", body=body)
        return cast(IssuedStreamCredential, result)

    async def demote_from_stage(self, stream_id: str, identity: str) -> None:
        await self._http.request(
            f"/v1/live-streams/{stream_id}/stage/demote", method="POST", body={"identity": identity}
        )

    async def leave(self, stream_id: str, identity: str) -> None:
        await self._http.request(f"/v1/live-streams/{stream_id}/leave", method="POST", body={"identity": identity})
