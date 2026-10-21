package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** {@link ConnectionSummary} plus the connection's events and errors. */
public record ConnectionDetail(
        String id,
        String publicId,
        String projectId,
        String roomId,
        String roomName,
        String participantId,
        String participantIdentity,
        ConnectionSummaryState state,
        String disconnectReason,
        String region,
        String sdkVersion,
        String platform,
        String browser,
        String networkType,
        String iceConnectionState,
        String signalingState,
        int reconnectCount,
        String startedAt,
        String connectedAt,
        String disconnectedAt,
        Long durationMs,
        String createdAt,
        String updatedAt,
        List<ConnectionEventEntry> events,
        List<ErrorSummary> errors) {

    /** This detail without its events and errors. */
    public ConnectionSummary summary() {
        return new ConnectionSummary(id, publicId, projectId, roomId, roomName, participantId, participantIdentity,
                state, disconnectReason, region, sdkVersion, platform, browser, networkType, iceConnectionState,
                signalingState, reconnectCount, startedAt, connectedAt, disconnectedAt, durationMs, createdAt,
                updatedAt);
    }
}
