from __future__ import annotations

from unittest.mock import MagicMock

from swalvo._types import CreateTokenParams, ListConnectionsParams, ListErrorsParams, TokenPermissions
from swalvo.resources.connections import ConnectionsResource
from swalvo.resources.errors import ErrorsResource
from swalvo.resources.projects import ProjectsResource
from swalvo.resources.rooms import RoomsResource
from swalvo.resources.tokens import TokensResource


def _fake_http(return_value=None):
    http = MagicMock()
    http.request.return_value = return_value
    return http


def test_projects_get_calls_v1_project() -> None:
    http = _fake_http({"id": "p1", "name": "demo"})
    resource = ProjectsResource(http)

    project = resource.get()

    http.request.assert_called_once_with("/v1/project")
    assert project["id"] == "p1"


def test_tokens_create_posts_the_swalvo_permission_vocabulary() -> None:
    http = _fake_http({"token": "t"})
    resource = TokensResource(http)

    resource.create(
        CreateTokenParams(
            room="room-123",
            identity="user-42",
            permissions=TokenPermissions(publish_audio=True, publish_video=True, subscribe=True),
            expires_in=3600,
        )
    )

    http.request.assert_called_once_with(
        "/v1/rooms/room-123/rtc-tokens",
        method="POST",
        body={
            "participantIdentity": "user-42",
            "permissions": {"publishAudio": True, "publishVideo": True, "subscribe": True},
            "ttlSeconds": 3600,
            "metadata": None,
            "attributes": None,
        },
    )


def test_rooms_crud() -> None:
    http = _fake_http({"id": "r1", "name": "lobby"})
    resource = RoomsResource(http)

    resource.list()
    http.request.assert_called_with("/v1/rooms")

    resource.get("r1")
    http.request.assert_called_with("/v1/rooms/r1")

    resource.create("lobby")
    http.request.assert_called_with("/v1/rooms", method="POST", body={"name": "lobby"})

    resource.create("lobby", get_or_create=True)
    http.request.assert_called_with("/v1/rooms", method="POST", body={"name": "lobby", "getOrCreate": True})

    resource.create("vault", e2ee=True)
    http.request.assert_called_with("/v1/rooms", method="POST", body={"name": "vault", "e2ee": True})

    resource.delete("r1")
    http.request.assert_called_with("/v1/rooms/r1", method="DELETE")


def test_room_participants_none_means_sfu_unreachable_not_empty() -> None:
    http = _fake_http(None)
    resource = RoomsResource(http)

    assert resource.participants.list("r1") is None
    assert resource.participants.get("r1", "alice") is None


def test_room_participants_get_finds_by_identity() -> None:
    http = _fake_http(
        [{"identity": "alice", "joinedAt": "t", "tracks": []}, {"identity": "bob", "joinedAt": "t", "tracks": []}]
    )
    resource = RoomsResource(http)

    assert resource.participants.get("r1", "bob")["identity"] == "bob"
    assert resource.participants.get("r1", "carol") is None


def test_connections_list_passes_typed_filters() -> None:
    http = _fake_http([])
    resource = ConnectionsResource(http)

    resource.list(ListConnectionsParams(room_id="room-1", state="CONNECTED", limit=25))

    http.request.assert_called_once_with(
        "/v1/connections", query={"roomId": "room-1", "state": "CONNECTED", "limit": 25}
    )


def test_errors_list_passes_typed_filters() -> None:
    http = _fake_http([])
    resource = ErrorsResource(http)

    resource.list(ListErrorsParams(category="ICE_ERROR", connection_id="conn_abc", limit=10))

    http.request.assert_called_once_with(
        "/v1/errors", query={"category": "ICE_ERROR", "connectionId": "conn_abc", "limit": 10}
    )


def test_errors_get() -> None:
    http = _fake_http({"publicId": "err_abc", "category": "TOKEN_ERROR"})
    resource = ErrorsResource(http)

    error = resource.get("err_abc")

    http.request.assert_called_once_with("/v1/errors/err_abc")
    assert error["category"] == "TOKEN_ERROR"
