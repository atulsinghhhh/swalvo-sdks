package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** A classified RTC error. */
public record ErrorSummary(
        String id,
        String publicId,
        String projectId,
        String connectionId,
        String roomId,
        String participantId,
        ErrorCategory category,
        String message,
        String likelyCause,
        String suggestedAction,
        String sdkVersion,
        String platform,
        String timestamp) {
}
