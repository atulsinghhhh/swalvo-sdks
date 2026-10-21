package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** A conversation membership. */
public record ChatMember(
        String id,
        String conversationId,
        String projectId,
        String userId,
        ChatMemberRole role,
        ChatMemberStatus status,
        String joinedAt,
        String leftAt) {
}
