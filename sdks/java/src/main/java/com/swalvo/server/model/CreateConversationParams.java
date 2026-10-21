package com.swalvo.server.model;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Parameters for {@code chat().createConversation()}.
 *
 * <p><b>Important:</b> a conversation created with no members is unreadable and unwritable by every chat
 * token, since your project API key isn't itself a chat user. List every userId that should be able to
 * connect in {@code members}, or call {@code addMember()} for each before minting their token.
 *
 * @param roomId attach to an existing RTC room, giving that call a chat panel.
 * @param getOrCreate when true, a name collision returns the existing conversation instead of throwing.
 *     {@code members} is ignored on that path.
 */
public record CreateConversationParams(
        String name,
        ChatConversationType type,
        String roomId,
        Integer retentionDays,
        List<ChatMemberParams> members,
        Map<String, Object> metadata,
        Boolean getOrCreate) {

    public CreateConversationParams {
        Copies.required(name, "name");
        members = Copies.list(members);
        metadata = Copies.map(metadata);
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String name;
        private ChatConversationType type;
        private String roomId;
        private Integer retentionDays;
        private List<ChatMemberParams> members;
        private Map<String, Object> metadata;
        private Boolean getOrCreate;

        private Builder() {}

        public Builder name(String name) { this.name = name; return this; }
        public Builder type(ChatConversationType type) { this.type = type; return this; }
        public Builder roomId(String roomId) { this.roomId = roomId; return this; }
        public Builder retentionDays(Integer days) { this.retentionDays = days; return this; }
        public Builder members(List<ChatMemberParams> members) { this.members = members; return this; }
        public Builder metadata(Map<String, Object> metadata) { this.metadata = metadata; return this; }
        public Builder getOrCreate(boolean value) { this.getOrCreate = value; return this; }

        /** Appends one member. */
        public Builder addMember(String userId, ChatMemberRole role) {
            if (members == null) members = new ArrayList<>();
            else members = new ArrayList<>(members);
            members.add(new ChatMemberParams(userId, role));
            return this;
        }

        public CreateConversationParams build() {
            return new CreateConversationParams(name, type, roomId, retentionDays, members, metadata, getOrCreate);
        }
    }
}
