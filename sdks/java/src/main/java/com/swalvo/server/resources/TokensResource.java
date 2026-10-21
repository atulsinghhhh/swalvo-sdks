package com.swalvo.server.resources;

import com.swalvo.server.internal.Bodies;
import com.swalvo.server.internal.HttpCore;
import com.swalvo.server.model.CreateTokenParams;
import com.swalvo.server.model.IssuedToken;

/**
 * Mint a short-lived RTC token server-side, then hand it to your frontend. Never hold on to a minted token
 * longer than it takes to forward it. There's no way to ask for a permanent one.
 */
public final class TokensResource {
    private final HttpCore http;

    public TokensResource(HttpCore http) {
        this.http = http;
    }

    /**
     * {@code POST /v1/rooms/:room/rtc-tokens}. Sends {@code identity} as {@code participantIdentity} and
     * {@code expiresIn} as {@code ttlSeconds}.
     */
    public IssuedToken create(CreateTokenParams params) {
        return http.send("POST", "/v1/rooms/" + HttpCore.segment(params.room()) + "/rtc-tokens",
                Bodies.of(
                        "participantIdentity", params.identity(),
                        "permissions", params.permissions(),
                        "ttlSeconds", params.expiresIn(),
                        "metadata", params.metadata()),
                HttpCore.type(IssuedToken.class));
    }
}
