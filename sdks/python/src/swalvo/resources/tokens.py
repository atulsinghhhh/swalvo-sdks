"""The core of this SDK (Phase 10 spec Section 15): mint a short-lived RTC
token server-side, then hand it to your frontend — never mint a token in the
browser, and never store a minted token any longer than you need to forward
it. Every token is short-lived by design; there is no way to request a
permanent one (see ``expires_in``).
"""

from __future__ import annotations

from typing import Any, cast

from .._async_http import AsyncSwalvoHttpClient
from .._http import SwalvoHttpClient
from .._types import CreateTokenParams, IssuedToken


def _token_body(params: CreateTokenParams) -> dict[str, Any]:
    return {
        "participantIdentity": params.identity,
        "permissions": params.permissions.to_json() if params.permissions else None,
        "ttlSeconds": params.expires_in,
        "metadata": params.metadata,
        "attributes": params.attributes,
    }


class TokensResource:
    def __init__(self, http: SwalvoHttpClient) -> None:
        self._http = http

    def create(self, params: CreateTokenParams) -> IssuedToken:
        result = self._http.request(f"/v1/rooms/{params.room}/rtc-tokens", method="POST", body=_token_body(params))
        return cast(IssuedToken, result)


class AsyncTokensResource:
    def __init__(self, http: AsyncSwalvoHttpClient) -> None:
        self._http = http

    async def create(self, params: CreateTokenParams) -> IssuedToken:
        result = await self._http.request(
            f"/v1/rooms/{params.room}/rtc-tokens", method="POST", body=_token_body(params)
        )
        return cast(IssuedToken, result)
