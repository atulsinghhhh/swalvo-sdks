package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** {@link ErrorSummary} plus the connection it happened on, if any. */
public record ErrorDetail(
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
        String timestamp,
        ConnectionSummary connection) {

    /** This detail without its connection. */
    public ErrorSummary summary() {
        return new ErrorSummary(id, publicId, projectId, connectionId, roomId, participantId, category, message,
                likelyCause, suggestedAction, sdkVersion, platform, timestamp);
    }
}
