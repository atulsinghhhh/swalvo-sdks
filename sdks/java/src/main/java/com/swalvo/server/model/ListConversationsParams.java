package com.swalvo.server.model;

/**
 * Filters for {@code chat().listConversations()}.
 *
 * @param userId only the conversations this user actively belongs to. Null for every conversation.
 */
public record ListConversationsParams(String userId, Boolean includeArchived) {

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String userId;
        private Boolean includeArchived;

        private Builder() {}

        public Builder userId(String userId) { this.userId = userId; return this; }
        public Builder includeArchived(boolean value) { this.includeArchived = value; return this; }

        public ListConversationsParams build() {
            return new ListConversationsParams(userId, includeArchived);
        }
    }
}
