package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** A chat message. */
public record ChatMessage(
        String id,
        String roomId,
        String conversationId,
        String senderId,
        ChatMessageType type,
        String text,
        String replyTo,
        String threadRootId,
        String clientMessageId,
        Map<String, Object> metadata,
        List<ChatReaction> reactions,
        boolean edited,
        boolean deleted,
        String createdAt,
        String updatedAt,
        String editedAt,
        String deletedAt) {
}
