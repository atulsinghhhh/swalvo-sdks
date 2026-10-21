"""Minimal FastAPI backend for a frontend that joins Swalvo rooms and chats —
the canonical flow: Browser -> your backend -> swalvo (Python SDK) -> Swalvo -> a
short-lived token -> back to the browser -> @swalvo/rtc or @swalvo/chat.

SWALVO_API_KEY never leaves this process. Never send it to the browser.

RTC and chat are separate planes with separate credentials, so this
mints them separately. Neither token works on the other plane.
"""

from __future__ import annotations

import os
import warnings

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.requests import Request
from pydantic import BaseModel

from swalvo import (
    CreateChatTokenParams,
    CreateConversationParams,
    CreateTokenParams,
    Swalvo,
    SwalvoError,
    TokenPermissions,
)

_warned_legacy_env = False


def _env(name: str, default: str | None = None) -> str | None:
    """Read SWALVO_<name>, falling back to the pre-rename RAVEN_/LIVQENO_ names."""
    global _warned_legacy_env
    value = os.environ.get(f"SWALVO_{name}")
    if value:
        return value
    for legacy in (f"RAVEN_{name}", f"LIVQENO_{name}"):
        value = os.environ.get(legacy)
        if value:
            if not _warned_legacy_env:
                _warned_legacy_env = True
                warnings.warn(f"{legacy} is deprecated; set SWALVO_{name} instead", DeprecationWarning, stacklevel=2)
            return value
    return default


_api_key = _env("API_KEY")
if not _api_key:
    raise RuntimeError("Set SWALVO_API_KEY to your Swalvo project API key")

swalvo = Swalvo(
    api_key=_api_key,
    base_url=_env("API_URL", "http://localhost:4100") or "http://localhost:4100",
)

app = FastAPI()


class TokenRequest(BaseModel):
    room: str
    identity: str


class ChatTokenRequest(BaseModel):
    room: str
    """Conversation name or conv_ id. Created on first use below."""
    user_id: str


@app.exception_handler(SwalvoError)
async def swalvo_error_handler(_request: Request, error: SwalvoError) -> JSONResponse:
    print(f"Swalvo token creation failed [{error.code}] (request {error.request_id or 'n/a'})")
    return JSONResponse(status_code=error.status_code or 502, content={"error": error.message, "code": error.code})


@app.post("/api/rtc/token")
async def create_token(request: TokenRequest) -> dict:
    if not request.room or not request.identity:
        raise HTTPException(status_code=400, detail="room and identity are required")

    # In a real app, `identity` should come from your own authenticated
    # session, never trusted verbatim from the request body — see
    # docs/security/server-sdk.md#authorization-model. Kept simple here to
    # focus the example on the Swalvo SDK call itself.
    token = swalvo.tokens.create(
        CreateTokenParams(
            room=request.room,
            identity=request.identity,
            permissions=TokenPermissions(join=True, subscribe=True, publish=True, publish_audio=True, publish_video=True),
            expires_in=3600,
        )
    )
    return token


@app.post("/api/chat/token")
async def create_chat_token(request: ChatTokenRequest) -> dict:
    """Mints a browser-safe chat token, creating the conversation on first use.

    Same caveat as the RTC endpoint above: `user_id` must come from your
    own authenticated session in a real app. Whoever controls it controls
    who Swalvo attributes messages to.
    """
    if not request.room or not request.user_id:
        raise HTTPException(status_code=400, detail="room and user_id are required")

    try:
        conversation = swalvo.chat.get_conversation(request.room)
    except SwalvoError as error:
        if error.status_code != 404:
            raise
        conversation = swalvo.chat.create_conversation(CreateConversationParams(name=request.room))

    # Membership is what authorizes the user inside the conversation; the
    # token alone isn't enough (docs/chat/overview.md#authorization).
    swalvo.chat.add_member(conversation["publicId"], request.user_id)

    token = swalvo.chat.create_token(
        CreateChatTokenParams(
            user_id=request.user_id,
            conversations=[conversation["publicId"]],
            expires_in=3600,
        )
    )
    return {**token, "roomId": conversation["publicId"], "roomName": conversation["name"]}
