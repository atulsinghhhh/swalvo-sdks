package com.swalvo.server.model;

/**
 * Cursor pagination for {@code chat().listMessages()}. Never an offset.
 *
 * @param before opaque cursor from a previous page's {@code nextCursor}; pages back.
 */
public record ListChatMessagesParams(
        Integer limit, String before, String after, String senderId, Boolean includeDeleted) {

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private Integer limit;
        private String before;
        private String after;
        private String senderId;
        private Boolean includeDeleted;

        private Builder() {}

        public Builder limit(Integer limit) { this.limit = limit; return this; }
        public Builder before(String cursor) { this.before = cursor; return this; }
        public Builder after(String cursor) { this.after = cursor; return this; }
        public Builder senderId(String senderId) { this.senderId = senderId; return this; }
        public Builder includeDeleted(boolean value) { this.includeDeleted = value; return this; }

        public ListChatMessagesParams build() {
            return new ListChatMessagesParams(limit, before, after, senderId, includeDeleted);
        }
    }
}
