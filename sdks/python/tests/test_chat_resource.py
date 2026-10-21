from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from swalvo._types import (
    ConversationMember,
    CreateChatTokenParams,
    CreateConversationParams,
    ListChatMessagesParams,
    SendChatMessageParams,
)
from swalvo.resources.chat import AsyncChatResource, ChatResource


def _fake_http(return_value=None):
    http = MagicMock()
    http.request.return_value = return_value
    return http


# ---------------------------------------------------------------------------
# Tokens — the security-critical method
# ---------------------------------------------------------------------------


def test_create_token_posts_the_wire_field_names() -> None:
    http = _fake_http({"token": "t"})
    resource = ChatResource(http)

    resource.create_token(
        CreateChatTokenParams(
            user_id="alice",
            conversations=["conv_1"],
            scopes=["chat:read", "chat:send"],
            expires_in=3600,
        )
    )

    # Python is snake_case, the API is camelCase, and `expires_in` maps to
    # `ttlSeconds` — the translation is this SDK's job, not the caller's.
    http.request.assert_called_once_with(
        "/v1/chat/tokens",
        method="POST",
        body={
            "userId": "alice",
            "conversations": ["conv_1"],
            "scopes": ["chat:read", "chat:send"],
            "ttlSeconds": 3600,
        },
    )


def test_create_token_omits_unset_fields_rather_than_sending_null() -> None:
    http = _fake_http({"token": "t"})
    resource = ChatResource(http)

    resource.create_token(CreateChatTokenParams(user_id="alice"))

    # Sending "scopes": null is not the same as omitting it — the former
    # can read as an explicit empty grant rather than "use the default".
    _, kwargs = http.request.call_args
    assert kwargs["body"] == {"userId": "alice"}


def test_create_token_returns_what_the_api_returned() -> None:
    http = _fake_http({"token": "eyJ...", "userId": "alice", "expiresAt": "2026-08-18T13:00:00.000Z"})
    resource = ChatResource(http)

    token = resource.create_token(CreateChatTokenParams(user_id="alice"))

    assert token["token"] == "eyJ..."
    assert token["userId"] == "alice"


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------


def test_create_conversation_flattens_members() -> None:
    http = _fake_http({"publicId": "conv_1"})
    resource = ChatResource(http)

    resource.create_conversation(
        CreateConversationParams(
            name="support",
            members=[
                ConversationMember(user_id="alice", role="ADMIN"),
                ConversationMember(user_id="bob"),
            ],
        )
    )

    _, kwargs = http.request.call_args
    assert kwargs["body"]["members"] == [
        {"userId": "alice", "role": "ADMIN"},
        # No role given, so none is sent — the API defaults it to MEMBER.
        {"userId": "bob"},
    ]


def test_create_conversation_attaches_an_rtc_room() -> None:
    http = _fake_http({"publicId": "conv_1", "type": "ROOM"})
    resource = ChatResource(http)

    resource.create_conversation(CreateConversationParams(name="standup-chat", room_id="8d863-uuid"))

    _, kwargs = http.request.call_args
    assert kwargs["body"]["roomId"] == "8d863-uuid"


@pytest.mark.parametrize(
    "room",
    ["conv_9WcQ4kRz1nB2xYtL", "support-room-42", "8d86361a-7c01-4969-98cb-d0748360b803"],
)
def test_conversation_reference_is_passed_through_verbatim(room: str) -> None:
    http = _fake_http({})
    resource = ChatResource(http)

    resource.get_conversation(room)

    # The API resolves a conv_ id, a name, or an attached RTC room id.
    # Guessing which one it was, or rewriting it, would break two of three.
    http.request.assert_called_once_with(f"/v1/chat/conversations/{room}")


def test_add_member_omits_role_when_unset() -> None:
    http = _fake_http({})
    resource = ChatResource(http)

    resource.add_member("conv_1", "bob")

    http.request.assert_called_once_with("/v1/chat/conversations/conv_1/members", method="POST", body={"userId": "bob"})


def test_remove_member_is_a_delete() -> None:
    http = _fake_http(None)
    resource = ChatResource(http)

    resource.remove_member("conv_1", "bob")

    http.request.assert_called_once_with("/v1/chat/conversations/conv_1/members/bob", method="DELETE")


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------


def test_send_message_requires_and_sends_the_sender() -> None:
    http = _fake_http({"id": "msg_1"})
    resource = ChatResource(http)

    resource.send_message("conv_1", SendChatMessageParams(sender_id="alice", text="Hello"))

    http.request.assert_called_once_with(
        "/v1/chat/conversations/conv_1/messages",
        method="POST",
        body={"senderId": "alice", "text": "Hello"},
    )


def test_send_message_can_post_a_system_message() -> None:
    http = _fake_http({"id": "msg_1", "type": "system"})
    resource = ChatResource(http)

    resource.send_message(
        "conv_1",
        SendChatMessageParams(sender_id="system", text="Maintenance in 5 minutes", type="system"),
    )

    # Server-only by design: a browser token is refused this type, so that
    # a user can't fabricate an official-looking announcement.
    _, kwargs = http.request.call_args
    assert kwargs["body"]["type"] == "system"


def test_send_message_forwards_the_idempotency_key() -> None:
    http = _fake_http({"id": "msg_1"})
    resource = ChatResource(http)

    resource.send_message(
        "conv_1",
        SendChatMessageParams(sender_id="alice", text="Hello", client_message_id="job_42"),
    )

    # This is what makes a retried backend job safe rather than duplicating.
    _, kwargs = http.request.call_args
    assert kwargs["body"]["clientMessageId"] == "job_42"


def test_list_messages_sends_cursors_as_query_parameters() -> None:
    http = _fake_http({"data": []})
    resource = ChatResource(http)

    resource.list_messages("conv_1", ListChatMessagesParams(limit=50, before="CURSOR_A"))

    http.request.assert_called_once_with(
        "/v1/chat/conversations/conv_1/messages",
        query={"limit": 50, "before": "CURSOR_A"},
    )


def test_list_messages_offers_no_offset_at_all() -> None:
    http = _fake_http({"data": []})
    resource = ChatResource(http)

    resource.list_messages("conv_1", ListChatMessagesParams(after="CURSOR_B"))

    _, kwargs = http.request.call_args
    # Offset pagination isn't merely discouraged here — there is no
    # parameter for it, so it can't be reached by accident.
    assert "offset" not in kwargs["query"]
    assert kwargs["query"]["after"] == "CURSOR_B"


def test_list_messages_without_params_sends_no_query() -> None:
    http = _fake_http({"data": []})
    resource = ChatResource(http)

    resource.list_messages("conv_1")

    http.request.assert_called_once_with("/v1/chat/conversations/conv_1/messages", query={})


def test_include_deleted_is_sent_as_a_json_boolean_string() -> None:
    http = _fake_http({"data": []})
    resource = ChatResource(http)

    resource.list_messages("conv_1", ListChatMessagesParams(include_deleted=True))

    # Python's str(True) is "True", which the API's boolean transform
    # rejects. It has to go over the wire as "true".
    _, kwargs = http.request.call_args
    assert kwargs["query"]["includeDeleted"] == "true"


def test_include_deleted_false_is_omitted_entirely() -> None:
    http = _fake_http({"data": []})
    resource = ChatResource(http)

    resource.list_messages("conv_1", ListChatMessagesParams(include_deleted=False))

    _, kwargs = http.request.call_args
    assert "includeDeleted" not in kwargs["query"]


def test_delete_message_is_a_delete_on_the_message_path() -> None:
    http = _fake_http({"id": "msg_1", "deleted": True})
    resource = ChatResource(http)

    message = resource.delete_message("msg_1")

    http.request.assert_called_once_with("/v1/chat/messages/msg_1", method="DELETE")
    assert message["deleted"] is True


# ---------------------------------------------------------------------------
# Async parity
# ---------------------------------------------------------------------------


class _AsyncHttp:
    """Minimal awaitable stand-in — MagicMock doesn't await cleanly."""

    def __init__(self, return_value=None) -> None:
        self.return_value = return_value
        self.calls: list[tuple[tuple, dict]] = []

    async def request(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return self.return_value


async def test_async_create_token_matches_the_sync_body() -> None:
    http = _AsyncHttp({"token": "t"})
    resource = AsyncChatResource(http)  # type: ignore[arg-type]

    await resource.create_token(CreateChatTokenParams(user_id="alice", expires_in=600))

    args, kwargs = http.calls[0]
    assert args[0] == "/v1/chat/tokens"
    assert kwargs["body"] == {"userId": "alice", "ttlSeconds": 600}


async def test_async_list_messages_matches_the_sync_query() -> None:
    http = _AsyncHttp({"data": []})
    resource = AsyncChatResource(http)  # type: ignore[arg-type]

    await resource.list_messages("conv_1", ListChatMessagesParams(limit=10))

    args, kwargs = http.calls[0]
    assert args[0] == "/v1/chat/conversations/conv_1/messages"
    assert kwargs["query"] == {"limit": 10}


async def test_async_surface_matches_sync_surface() -> None:
    # The two clients must not drift. A method that exists on one and not
    # the other is a bug a user only finds after switching.
    sync_methods = {m for m in dir(ChatResource) if not m.startswith("_")}
    async_methods = {m for m in dir(AsyncChatResource) if not m.startswith("_")}
    assert sync_methods == async_methods
