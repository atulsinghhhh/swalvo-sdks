package com.swalvo.server.model;

/**
 * Parameters for {@code tokens().create()}.
 *
 * @param room the room's id, from {@code rooms().create()} or {@code rooms().list()}. Not its display name.
 * @param identity unique within the room. Letters, numbers, "-", "_", "." only.
 * @param expiresIn token lifetime in seconds, 30 to 21600. Null for the API's default. Never permanent.
 */
public record CreateTokenParams(
        String room, String identity, TokenPermissions permissions, Integer expiresIn, String metadata) {

    public CreateTokenParams {
        Copies.required(room, "room");
        Copies.required(identity, "identity");
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String room;
        private String identity;
        private TokenPermissions permissions;
        private Integer expiresIn;
        private String metadata;

        private Builder() {}

        public Builder room(String room) { this.room = room; return this; }
        public Builder identity(String identity) { this.identity = identity; return this; }
        public Builder permissions(TokenPermissions permissions) { this.permissions = permissions; return this; }
        public Builder expiresIn(Integer seconds) { this.expiresIn = seconds; return this; }
        public Builder metadata(String metadata) { this.metadata = metadata; return this; }

        public CreateTokenParams build() {
            return new CreateTokenParams(room, identity, permissions, expiresIn, metadata);
        }
    }
}
