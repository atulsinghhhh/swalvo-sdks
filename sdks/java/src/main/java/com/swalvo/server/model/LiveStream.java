package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** A live stream: an RTC room plus a chat conversation, with lifecycle and role bookkeeping. */
public record LiveStream(
        String id,
        String title,
        String description,
        String thumbnailUrl,
        String category,
        List<String> tags,
        String language,
        LiveStreamVisibility visibility,
        Map<String, Object> metadata,
        LiveStreamStatus status,
        List<LiveStreamHostView> hosts,
        /** Live non-host participants. Null means the SFU couldn't be reached, not a genuine 0. */
        Integer viewerCount,
        int peakViewerCount,
        /** The audience delivery path. Null if the API didn't include it. */
        LiveStreamDelivery delivery,
        String conversationId,
        /** The chat message viewer reactions attach to. */
        String chatRootMessageId,
        String scheduledAt,
        String startedAt,
        String endedAt,
        String createdAt,
        String updatedAt) {
}
