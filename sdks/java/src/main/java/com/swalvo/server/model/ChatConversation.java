package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** A chat conversation. */
public record ChatConversation(
        String id,
        String publicId,
        String projectId,
        String roomId,
        String name,
        ChatConversationType type,
        ChatConversationStatus status,
        Integer retentionDays,
        Map<String, Object> metadata,
        String createdAt,
        String updatedAt) {
}
