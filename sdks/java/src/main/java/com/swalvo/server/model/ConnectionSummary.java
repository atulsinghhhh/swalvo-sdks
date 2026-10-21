package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** A stored, event-sourced RTC connection record. */
public record ConnectionSummary(
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
        String updatedAt) {
}
