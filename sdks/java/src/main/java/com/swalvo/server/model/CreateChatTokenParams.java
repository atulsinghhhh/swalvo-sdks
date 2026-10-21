package com.swalvo.server.model;

import java.util.List;

/**
 * Parameters for {@code chat().createToken()}.
 *
 * @param userId your own user identity. Everything this token sends is attributed to it.
 * @param conversations conversations the token may touch. Null for every conversation the user belongs to.
 * @param scopes narrows the token below the user's role. Cannot grant anything the role lacks.
 * @param expiresIn lifetime in seconds (sent as {@code ttlSeconds}). There's no non-expiring chat token.
 */
public record CreateChatTokenParams(
        String userId, List<String> conversations, List<ChatScope> scopes, Integer expiresIn) {

    public CreateChatTokenParams {
        Copies.required(userId, "userId");
        conversations = Copies.list(conversations);
        scopes = Copies.list(scopes);
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String userId;
        private List<String> conversations;
        private List<ChatScope> scopes;
        private Integer expiresIn;

        private Builder() {}

        public Builder userId(String userId) { this.userId = userId; return this; }
        public Builder conversations(List<String> conversations) { this.conversations = conversations; return this; }
        public Builder conversations(String... conversations) { this.conversations = List.of(conversations); return this; }
        public Builder scopes(List<ChatScope> scopes) { this.scopes = scopes; return this; }
        public Builder scopes(ChatScope... scopes) { this.scopes = List.of(scopes); return this; }
        public Builder expiresIn(Integer seconds) { this.expiresIn = seconds; return this; }

        public CreateChatTokenParams build() {
            return new CreateChatTokenParams(userId, conversations, scopes, expiresIn);
        }
    }
}
