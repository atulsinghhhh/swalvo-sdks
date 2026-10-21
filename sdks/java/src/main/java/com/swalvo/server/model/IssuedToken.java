package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** A short-lived RTC token. Forward it to your frontend; never hold on to it. */
public record IssuedToken(
        String id,
        String token,
        /** Where the client SDK connects. Forward it untouched. */
        String endpoint,
        String roomId,
        String roomName,
        String participantIdentity,
        TokenPermissions permissions,
        List<IceServer> iceServers,
        String telemetryUrl,
        String expiresAt,
        String createdAt) {
}
