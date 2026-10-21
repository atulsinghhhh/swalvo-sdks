"""Rooms are control-plane records, not persistent infrastructure — ``delete()``
closes a room (soft-close, sets status to CLOSED) rather than destroying
history, matching the actual API (Phase 10 spec Section 18).
"""

from __future__ import annotations

import base64
from collections.abc import Sequence
from typing import Any, Literal, cast
from urllib.parse import quote

from .._async_http import AsyncSwalvoHttpClient
from .._http import SwalvoHttpClient
from .._types import (
    LiveParticipantInfo,
    LiveParticipantPermissions,
    ParticipantMetadataResult,
    Room,
    SendDataResult,
)


def _seg(value: str) -> str:
    return quote(value, safe="")


def _participant_path(room_id: str, identity: str, suffix: str = "") -> str:
    return f"/v1/rooms/{_seg(room_id)}/participants/{_seg(identity)}{suffix}"


def _mute_body(muted: bool, track_id: str | None, kind: Literal["audio", "video"] | None) -> dict[str, Any]:
    if not track_id and not kind:
        raise ValueError("mute_participant needs one of track_id or kind")
    body: dict[str, Any] = {"muted": muted}
    if track_id:
        body["trackId"] = track_id
    if kind:
        body["kind"] = kind
    return body


def _permissions_body(
    subscribe: bool | None,
    publish: bool | None,
    publish_audio: bool | None,
    publish_video: bool | None,
    publish_screen: bool | None,
    publish_data: bool | None,
    update_own_metadata: bool | None,
) -> dict[str, bool]:
    mapping = {
        "subscribe": subscribe,
        "publish": publish,
        "publishAudio": publish_audio,
        "publishVideo": publish_video,
        "publishScreen": publish_screen,
        "publishData": publish_data,
        "updateOwnMetadata": update_own_metadata,
    }
    return {key: value for key, value in mapping.items() if value is not None}


def _update_body(metadata: str | None, attributes: dict[str, str | None] | None) -> dict[str, Any]:
    if metadata is None and attributes is None:
        raise ValueError("update_participant needs metadata, attributes, or both")
    body: dict[str, Any] = {}
    if metadata is not None:
        body["metadata"] = metadata
    if attributes is not None:
        body["attributes"] = attributes
    return body


def _data_body(
    payload: bytes | str,
    topic: str | None,
    destination_identities: Sequence[str] | None,
    reliable: bool | None,
) -> dict[str, Any]:
    raw = payload.encode("utf-8") if isinstance(payload, str) else bytes(payload)
    body: dict[str, Any] = {"payload": base64.b64encode(raw).decode("ascii")}
    if topic is not None:
        body["topic"] = topic
    if destination_identities is not None:
        body["destinationIdentities"] = list(destination_identities)
    if reliable is not None:
        body["reliable"] = reliable
    return body


class RoomParticipantsResource:
    """Real join/leave participant *history* isn't wired up in the Control API
    yet — this always reflects the SFU's current live state (Phase 10 spec
    Section 19), never a stored roster. ``None`` means the SFU couldn't be
    reached, distinct from a genuinely empty room (``[]``) — never coerced to one.
    """

    def __init__(self, http: SwalvoHttpClient) -> None:
        self._http = http

    def list(self, room_id: str) -> list[LiveParticipantInfo] | None:
        result = self._http.request(f"/v1/rooms/{room_id}/participants")
        return cast("list[LiveParticipantInfo] | None", result)

    def get(self, room_id: str, identity: str) -> LiveParticipantInfo | None:
        participants = self.list(room_id)
        if participants is None:
            return None
        return next((p for p in participants if p.get("identity") == identity), None)


class AsyncRoomParticipantsResource:
    def __init__(self, http: AsyncSwalvoHttpClient) -> None:
        self._http = http

    async def list(self, room_id: str) -> list[LiveParticipantInfo] | None:
        result = await self._http.request(f"/v1/rooms/{room_id}/participants")
        return cast("list[LiveParticipantInfo] | None", result)

    async def get(self, room_id: str, identity: str) -> LiveParticipantInfo | None:
        participants = await self.list(room_id)
        if participants is None:
            return None
        return next((p for p in participants if p.get("identity") == identity), None)


class RoomsResource:
    def __init__(self, http: SwalvoHttpClient) -> None:
        self._http = http
        self.participants = RoomParticipantsResource(http)

    def list(self) -> list[Room]:
        return cast("list[Room]", self._http.request("/v1/rooms"))

    def get(self, room_id: str) -> Room:
        return cast(Room, self._http.request(f"/v1/rooms/{room_id}"))

    def create(self, name: str, get_or_create: bool = False, e2ee: bool | None = None) -> Room:
        """``get_or_create=True`` returns the existing room on a name collision
        instead of raising — pass it when several participants create the
        room they are all about to join.

        ``e2ee=True`` makes the room end-to-end encrypted (keys never reach
        Swalvo; server-side egress/ingress is refused). Fixed at create; with
        ``get_or_create``, a mismatch with an existing room raises a conflict."""
        body: dict[str, Any] = {"name": name}
        if get_or_create:
            body["getOrCreate"] = True
        if e2ee is not None:
            body["e2ee"] = e2ee
        return cast(Room, self._http.request("/v1/rooms", method="POST", body=body))

    def delete(self, room_id: str) -> None:
        self._http.request(f"/v1/rooms/{room_id}", method="DELETE")

    # --- Server moderation and participant metadata -------------------------
    # ``room_id`` takes the room's id or its name. The participant must be
    # connected right now; one who is not raises a 404
    # (``RAVEN_PARTICIPANT_NOT_CONNECTED``).

    def remove_participant(self, room_id: str, identity: str) -> None:
        """Remove a participant from the live room. Does not revoke their token."""
        self._http.request(_participant_path(room_id, identity, "/remove"), method="POST")

    def mute_participant(
        self,
        room_id: str,
        identity: str,
        *,
        muted: bool,
        track_id: str | None = None,
        kind: Literal["audio", "video"] | None = None,
    ) -> None:
        """Mute or unmute one track (``track_id``) or every track of a ``kind``."""
        body = _mute_body(muted, track_id, kind)
        self._http.request(_participant_path(room_id, identity, "/mute"), method="POST", body=body)

    def update_participant_permissions(
        self,
        room_id: str,
        identity: str,
        *,
        subscribe: bool | None = None,
        publish: bool | None = None,
        publish_audio: bool | None = None,
        publish_video: bool | None = None,
        publish_screen: bool | None = None,
        publish_data: bool | None = None,
        update_own_metadata: bool | None = None,
    ) -> LiveParticipantPermissions:
        """Merge a permission change into a connected participant's grant; returns the result."""
        body = _permissions_body(
            subscribe, publish, publish_audio, publish_video, publish_screen, publish_data, update_own_metadata
        )
        result = self._http.request(_participant_path(room_id, identity, "/permissions"), method="PATCH", body=body)
        return cast(LiveParticipantPermissions, result)

    def update_participant(
        self,
        room_id: str,
        identity: str,
        *,
        metadata: str | None = None,
        attributes: dict[str, str | None] | None = None,
    ) -> ParticipantMetadataResult:
        """Replace metadata and/or merge attributes (``None`` as a value deletes that key).

        Everyone in the room receives ``participant.updated``. Returns the resulting values.
        """
        body = _update_body(metadata, attributes)
        result = self._http.request(_participant_path(room_id, identity), method="PATCH", body=body)
        return cast(ParticipantMetadataResult, result)

    def send_data(
        self,
        room_id: str,
        payload: bytes | str,
        *,
        topic: str | None = None,
        destination_identities: Sequence[str] | None = None,
        reliable: bool | None = None,
    ) -> SendDataResult:
        """Send a data message into the room from the server (empty sender identity).

        Up to 64 KiB reliable (the default), 1,200 bytes with ``reliable=False``.
        Best-effort, and never retried by the SDK so a retry cannot deliver it twice.
        """
        body = _data_body(payload, topic, destination_identities, reliable)
        result = self._http.request(f"/v1/rooms/{_seg(room_id)}/data", method="POST", body=body, retryable=False)
        return cast(SendDataResult, result)


class AsyncRoomsResource:
    def __init__(self, http: AsyncSwalvoHttpClient) -> None:
        self._http = http
        self.participants = AsyncRoomParticipantsResource(http)

    async def list(self) -> list[Room]:
        return cast("list[Room]", await self._http.request("/v1/rooms"))

    async def get(self, room_id: str) -> Room:
        return cast(Room, await self._http.request(f"/v1/rooms/{room_id}"))

    async def create(self, name: str, get_or_create: bool = False, e2ee: bool | None = None) -> Room:
        """``get_or_create=True`` returns the existing room on a name collision
        instead of raising — pass it when several participants create the
        room they are all about to join.

        ``e2ee=True`` makes the room end-to-end encrypted (keys never reach
        Swalvo; server-side egress/ingress is refused). Fixed at create; with
        ``get_or_create``, a mismatch with an existing room raises a conflict."""
        body: dict[str, Any] = {"name": name}
        if get_or_create:
            body["getOrCreate"] = True
        if e2ee is not None:
            body["e2ee"] = e2ee
        return cast(Room, await self._http.request("/v1/rooms", method="POST", body=body))

    async def delete(self, room_id: str) -> None:
        await self._http.request(f"/v1/rooms/{room_id}", method="DELETE")

    # --- Server moderation and participant metadata -------------------------
    # ``room_id`` takes the room's id or its name. The participant must be
    # connected right now; one who is not raises a 404
    # (``RAVEN_PARTICIPANT_NOT_CONNECTED``).

    async def remove_participant(self, room_id: str, identity: str) -> None:
        """Remove a participant from the live room. Does not revoke their token."""
        await self._http.request(_participant_path(room_id, identity, "/remove"), method="POST")

    async def mute_participant(
        self,
        room_id: str,
        identity: str,
        *,
        muted: bool,
        track_id: str | None = None,
        kind: Literal["audio", "video"] | None = None,
    ) -> None:
        """Mute or unmute one track (``track_id``) or every track of a ``kind``."""
        body = _mute_body(muted, track_id, kind)
        await self._http.request(_participant_path(room_id, identity, "/mute"), method="POST", body=body)

    async def update_participant_permissions(
        self,
        room_id: str,
        identity: str,
        *,
        subscribe: bool | None = None,
        publish: bool | None = None,
        publish_audio: bool | None = None,
        publish_video: bool | None = None,
        publish_screen: bool | None = None,
        publish_data: bool | None = None,
        update_own_metadata: bool | None = None,
    ) -> LiveParticipantPermissions:
        """Merge a permission change into a connected participant's grant; returns the result."""
        body = _permissions_body(
            subscribe, publish, publish_audio, publish_video, publish_screen, publish_data, update_own_metadata
        )
        result = await self._http.request(
            _participant_path(room_id, identity, "/permissions"), method="PATCH", body=body
        )
        return cast(LiveParticipantPermissions, result)

    async def update_participant(
        self,
        room_id: str,
        identity: str,
        *,
        metadata: str | None = None,
        attributes: dict[str, str | None] | None = None,
    ) -> ParticipantMetadataResult:
        """Replace metadata and/or merge attributes (``None`` as a value deletes that key).

        Everyone in the room receives ``participant.updated``. Returns the resulting values.
        """
        body = _update_body(metadata, attributes)
        result = await self._http.request(_participant_path(room_id, identity), method="PATCH", body=body)
        return cast(ParticipantMetadataResult, result)

    async def send_data(
        self,
        room_id: str,
        payload: bytes | str,
        *,
        topic: str | None = None,
        destination_identities: Sequence[str] | None = None,
        reliable: bool | None = None,
    ) -> SendDataResult:
        """Send a data message into the room from the server (empty sender identity).

        Up to 64 KiB reliable (the default), 1,200 bytes with ``reliable=False``.
        Best-effort, and never retried by the SDK so a retry cannot deliver it twice.
        """
        body = _data_body(payload, topic, destination_identities, reliable)
        result = await self._http.request(f"/v1/rooms/{_seg(room_id)}/data", method="POST", body=body, retryable=False)
        return cast(SendDataResult, result)
