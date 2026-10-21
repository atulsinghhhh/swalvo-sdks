package com.swalvo.server.model;

/** A user to add to a conversation, for {@code chat().addMember()} or {@code CreateConversationParams.members}. */
public record ChatMemberParams(String userId, ChatMemberRole role) {

    public ChatMemberParams {
        Copies.required(userId, "userId");
    }

    /** A plain MEMBER. */
    public static ChatMemberParams of(String userId) {
        return new ChatMemberParams(userId, null);
    }

    public static ChatMemberParams of(String userId, ChatMemberRole role) {
        return new ChatMemberParams(userId, role);
    }
}
