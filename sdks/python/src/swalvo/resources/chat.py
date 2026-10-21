"""Swalvo Chat, server-side (Phase 12).

The important method here is ``create_token()``. The whole security model
rests on it: your backend authenticates the user *its* way, then asks Swalvo
for a short-lived token scoped to that one user, and only that token reaches
the browser or the mobile app. The project API key this SDK holds never does.

The rest exists for what a backend genuinely needs to do — provision
conversations, manage membership, post system messages, and read history for
export or moderation.
"""

from __future__ import annotations

from typing import Any, cast

from .._async_http import AsyncSwalvoHttpClient
from .._http import SwalvoHttpClient
from .._types import (
    ChatConversation,
    ChatMember,
    ChatMemberRole,
    ChatMessage,
    ChatMessagePage,
    CreateChatTokenParams,
    CreateConversationParams,
    IssuedChatToken,
    ListChatMessagesParams,
    SendChatMessageParams,
)


def _drop_none(payload: dict[str, Any]) -> dict[str, Any]:
    """Strips unset fields so the API applies its own defaults.

    Sending ``"scopes": null`` is not the same as omitting it — the former
    can read as an explicit empty grant.
    """
    return {key: value for key, value in payload.items() if value is not None}


def _token_body(params: CreateChatTokenParams) -> dict[str, Any]:
    return _drop_none(
        {
            "userId": params.user_id,
            "conversations": params.conversations,
            "scopes": params.scopes,
            "ttlSeconds": params.expires_in,
        }
    )


def _conversation_body(params: CreateConversationParams) -> dict[str, Any]:
    return _drop_none(
        {
            "name": params.name,
            "type": params.type,
            "roomId": params.room_id,
            "retentionDays": params.retention_days,
            "members": (
                [_drop_none({"userId": m.user_id, "role": m.role}) for m in params.members]
                if params.members is not None
                else None
            ),
            "metadata": params.metadata,
            "getOrCreate": params.get_or_create,
        }
    )


def _message_body(params: SendChatMessageParams) -> dict[str, Any]:
    return _drop_none(
        {
            "senderId": params.sender_id,
            "text": params.text,
            "type": params.type,
            "replyTo": params.reply_to,
            "clientMessageId": params.client_message_id,
            "attachmentId": params.attachment_id,
            "metadata": params.metadata,
        }
    )


def _messages_query(params: ListChatMessagesParams | None) -> dict[str, Any]:
    if params is None:
        return {}
    return _drop_none(
        {
            "limit": params.limit,
            "before": params.before,
            "after": params.after,
            "senderId": params.sender_id,
            "threadRootId": params.thread_root_id,
            # The API parses this from a query string, so it needs the
            # lowercase JSON spelling rather than Python's "True".
            "includeDeleted": "true" if params.include_deleted else None,
        }
    )


def _conversation_path(room: str, suffix: str = "") -> str:
    """``room`` accepts a ``conv_`` id, the conversation name, or an attached RTC room id."""
    return f"/v1/chat/conversations/{room}{suffix}"


class ChatResource:
    def __init__(self, http: SwalvoHttpClient) -> None:
        self._http = http

    def create_token(self, params: CreateChatTokenParams) -> IssuedChatToken:
        """Mints a browser-safe chat token.

        ``scopes`` can only ever *narrow* what the user's role already
        allows — listing ``chat:moderate`` does not grant it. That makes it
        safe to pass a caller's scope list straight through.
        """
        result = self._http.request("/v1/chat/tokens", method="POST", body=_token_body(params))
        return cast(IssuedChatToken, result)

    def create_conversation(self, params: CreateConversationParams) -> ChatConversation:
        result = self._http.request("/v1/chat/conversations", method="POST", body=_conversation_body(params))
        return cast(ChatConversation, result)

    def list_conversations(self) -> list[ChatConversation]:
        return cast("list[ChatConversation]", self._http.request("/v1/chat/conversations"))

    def get_conversation(self, room: str) -> ChatConversation:
        return cast(ChatConversation, self._http.request(_conversation_path(room)))

    def add_member(self, room: str, user_id: str, role: ChatMemberRole | None = None) -> ChatMember:
        body = _drop_none({"userId": user_id, "role": role})
        result = self._http.request(_conversation_path(room, "/members"), method="POST", body=body)
        return cast(ChatMember, result)

    def remove_member(self, room: str, user_id: str) -> None:
        self._http.request(_conversation_path(room, f"/members/{user_id}"), method="DELETE")

    def list_members(self, room: str) -> list[ChatMember]:
        return cast("list[ChatMember]", self._http.request(_conversation_path(room, "/members")))

    def send_message(self, room: str, params: SendChatMessageParams) -> ChatMessage:
        """Posts a message as any user in the project.

        This is why the method is server-only: ``type="system"`` is
        available here and nowhere else, because a browser must never be
        able to fabricate a system announcement.
        """
        result = self._http.request(_conversation_path(room, "/messages"), method="POST", body=_message_body(params))
        return cast(ChatMessage, result)

    def list_messages(self, room: str, params: ListChatMessagesParams | None = None) -> ChatMessagePage:
        """Cursor-paginated history, newest first.

        Pass a previous page's ``nextCursor`` as ``before`` to page back.
        Never an offset — see docs/chat/messages.md#why-cursors-and-not-offsets.
        """
        result = self._http.request(_conversation_path(room, "/messages"), query=_messages_query(params))
        return cast(ChatMessagePage, result)

    def delete_message(self, message_id: str) -> ChatMessage:
        """Soft-deletes a message. The row survives with a ``deletedAt``, so
        moderation keeps an audit trail and clients can render a placeholder.
        """
        return cast(ChatMessage, self._http.request(f"/v1/chat/messages/{message_id}", method="DELETE"))


class AsyncChatResource:
    def __init__(self, http: AsyncSwalvoHttpClient) -> None:
        self._http = http

    async def create_token(self, params: CreateChatTokenParams) -> IssuedChatToken:
        result = await self._http.request("/v1/chat/tokens", method="POST", body=_token_body(params))
        return cast(IssuedChatToken, result)

    async def create_conversation(self, params: CreateConversationParams) -> ChatConversation:
        result = await self._http.request("/v1/chat/conversations", method="POST", body=_conversation_body(params))
        return cast(ChatConversation, result)

    async def list_conversations(self) -> list[ChatConversation]:
        return cast("list[ChatConversation]", await self._http.request("/v1/chat/conversations"))

    async def get_conversation(self, room: str) -> ChatConversation:
        return cast(ChatConversation, await self._http.request(_conversation_path(room)))

    async def add_member(self, room: str, user_id: str, role: ChatMemberRole | None = None) -> ChatMember:
        body = _drop_none({"userId": user_id, "role": role})
        result = await self._http.request(_conversation_path(room, "/members"), method="POST", body=body)
        return cast(ChatMember, result)

    async def remove_member(self, room: str, user_id: str) -> None:
        await self._http.request(_conversation_path(room, f"/members/{user_id}"), method="DELETE")

    async def list_members(self, room: str) -> list[ChatMember]:
        return cast("list[ChatMember]", await self._http.request(_conversation_path(room, "/members")))

    async def send_message(self, room: str, params: SendChatMessageParams) -> ChatMessage:
        result = await self._http.request(
            _conversation_path(room, "/messages"), method="POST", body=_message_body(params)
        )
        return cast(ChatMessage, result)

    async def list_messages(self, room: str, params: ListChatMessagesParams | None = None) -> ChatMessagePage:
        result = await self._http.request(_conversation_path(room, "/messages"), query=_messages_query(params))
        return cast(ChatMessagePage, result)

    async def delete_message(self, message_id: str) -> ChatMessage:
        return cast(ChatMessage, await self._http.request(f"/v1/chat/messages/{message_id}", method="DELETE"))
