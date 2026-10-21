"""Server moderation, participant metadata, server data and webhook verification."""

from __future__ import annotations

import hashlib
import hmac
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from swalvo import SwalvoError, verify_webhook
from swalvo._types import CreateTokenParams, TokenPermissions
from swalvo.resources.rooms import AsyncRoomsResource, RoomsResource
from swalvo.resources.tokens import TokensResource

SECRET = "whsec_test"
NOW = 1_800_000_000
BODY = json.dumps({"id": "evt_1", "type": "room.participant_joined", "data": {"identity": "alice"}})


def _sign(body: str, secret: str = SECRET, t: int = NOW) -> str:
    """Mirrors apps/api's signWebhookPayload."""
    digest = hmac.new(secret.encode(), f"{t}.{body}".encode(), hashlib.sha256).hexdigest()
    return f"t={t},v1={digest}"


def _rooms(return_value: object = None) -> tuple[MagicMock, RoomsResource]:
    http = MagicMock()
    http.request.return_value = return_value
    return http, RoomsResource(http)


def test_tokens_create_passes_metadata_attributes_and_update_own_metadata() -> None:
    http = MagicMock()
    TokensResource(http).create(
        CreateTokenParams(
            room="r1",
            identity="alice",
            permissions=TokenPermissions(join=True, update_own_metadata=True),
            metadata='{"name":"Alice"}',
            attributes={"role": "host"},
        )
    )
    body = http.request.call_args.kwargs["body"]
    assert body["permissions"] == {"join": True, "updateOwnMetadata": True}
    assert body["metadata"] == '{"name":"Alice"}'
    assert body["attributes"] == {"role": "host"}


def test_remove_participant_encodes_path_segments() -> None:
    http, rooms = _rooms()
    rooms.remove_participant("my room", "a/b")
    http.request.assert_called_once_with("/v1/rooms/my%20room/participants/a%2Fb/remove", method="POST")


def test_mute_participant_requires_track_or_kind() -> None:
    http, rooms = _rooms()
    rooms.mute_participant("r1", "alice", muted=True, kind="audio")
    http.request.assert_called_once_with(
        "/v1/rooms/r1/participants/alice/mute", method="POST", body={"muted": True, "kind": "audio"}
    )
    with pytest.raises(ValueError):
        rooms.mute_participant("r1", "alice", muted=True)


def test_update_participant_permissions_sends_only_what_was_named() -> None:
    http, rooms = _rooms({"publish": False})
    assert rooms.update_participant_permissions("r1", "alice", publish=False, update_own_metadata=True) == {
        "publish": False
    }
    http.request.assert_called_once_with(
        "/v1/rooms/r1/participants/alice/permissions",
        method="PATCH",
        body={"publish": False, "updateOwnMetadata": True},
    )


def test_update_participant_patches_metadata_and_attributes() -> None:
    http, rooms = _rooms({"identity": "alice", "metadata": "m", "attributes": {}})
    rooms.update_participant("r1", "alice", metadata="m", attributes={"hand": None})
    http.request.assert_called_once_with(
        "/v1/rooms/r1/participants/alice", method="PATCH", body={"metadata": "m", "attributes": {"hand": None}}
    )
    with pytest.raises(ValueError):
        rooms.update_participant("r1", "alice")


def test_send_data_base64_encodes_and_is_never_retried() -> None:
    http, rooms = _rooms({"messageId": "m1"})
    assert rooms.send_data("r1", "hi", topic="chat", destination_identities=["bob"], reliable=False) == {
        "messageId": "m1"
    }
    http.request.assert_called_once_with(
        "/v1/rooms/r1/data",
        method="POST",
        body={"payload": "aGk=", "topic": "chat", "destinationIdentities": ["bob"], "reliable": False},
        retryable=False,
    )
    rooms.send_data("r1", b"\x01\x02\x03")
    assert http.request.call_args.kwargs["body"] == {"payload": "AQID"}


async def test_async_rooms_helpers() -> None:
    http = MagicMock()
    http.request = AsyncMock(return_value={"identity": "alice", "metadata": "", "attributes": {"a": "1"}})
    rooms = AsyncRoomsResource(http)
    result = await rooms.update_participant("r1", "alice", attributes={"a": "1"})
    assert result["attributes"] == {"a": "1"}
    await rooms.send_data("r1", b"x")
    assert http.request.call_args.kwargs["retryable"] is False


def test_verify_webhook_accepts_a_valid_signature() -> None:
    assert verify_webhook(BODY, _sign(BODY), SECRET, now=NOW)["id"] == "evt_1"
    assert verify_webhook(BODY.encode(), _sign(BODY), SECRET, now=NOW)["type"] == "room.participant_joined"


@pytest.mark.parametrize(
    ("body", "header", "secret", "code"),
    [
        (BODY.replace("alice", "mallory"), _sign(BODY), SECRET, "RAVEN_WEBHOOK_INVALID_SIGNATURE"),
        (BODY, _sign(BODY, "other"), SECRET, "RAVEN_WEBHOOK_INVALID_SIGNATURE"),
        (BODY, None, SECRET, "RAVEN_WEBHOOK_INVALID_SIGNATURE"),
        (BODY, "garbage", SECRET, "RAVEN_WEBHOOK_INVALID_SIGNATURE"),
        (BODY, f"t={NOW}", SECRET, "RAVEN_WEBHOOK_INVALID_SIGNATURE"),
        (BODY, _sign(BODY, t=NOW - 301), SECRET, "RAVEN_WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE"),
        (BODY, _sign(BODY, t=NOW + 301), SECRET, "RAVEN_WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE"),
        ("not json", _sign("not json"), SECRET, "RAVEN_WEBHOOK_INVALID_PAYLOAD"),
        ("[1]", _sign("[1]"), SECRET, "RAVEN_WEBHOOK_INVALID_PAYLOAD"),
        (BODY, _sign(BODY), "", "RAVEN_INVALID_CONFIG"),
    ],
)
def test_verify_webhook_rejections(body: str, header: str | None, secret: str, code: str) -> None:
    with pytest.raises(SwalvoError) as info:
        verify_webhook(body, header, secret, now=NOW)
    assert info.value.code == code


def test_verify_webhook_tolerance_multiple_signatures_and_rotation() -> None:
    verify_webhook(BODY, _sign(BODY, t=NOW - 300), SECRET, now=NOW)
    verify_webhook(BODY, _sign(BODY, t=NOW - 1000), SECRET, now=NOW, tolerance_seconds=1000)
    several = f"t={NOW},v1={'0' * 64},{_sign(BODY).split(',')[1]}"
    assert verify_webhook(BODY, several, SECRET, now=NOW)["id"] == "evt_1"
    assert verify_webhook(BODY, _sign(BODY, "new"), ["old", "new"], now=NOW)["id"] == "evt_1"
