package com.swalvo.server.model;

/**
 * Parameters for {@code rooms().create()}.
 *
 * @param getOrCreate when true, a name collision (including two participants racing to create the same room)
 *     returns the existing room instead of a 409.
 * @param e2ee end-to-end encrypted media, fixed for the room's life. Server-side processing that needs
 *     plaintext (HLS, recording, restream, ingress) is refused with {@code E2EE_NOT_SUPPORTED}.
 */
public record CreateRoomParams(String name, Boolean getOrCreate, Boolean e2ee) {

    public CreateRoomParams {
        Copies.required(name, "name");
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String name;
        private Boolean getOrCreate;
        private Boolean e2ee;

        private Builder() {}

        public Builder name(String name) { this.name = name; return this; }
        public Builder getOrCreate(boolean value) { this.getOrCreate = value; return this; }
        public Builder e2ee(boolean value) { this.e2ee = value; return this; }

        public CreateRoomParams build() {
            return new CreateRoomParams(name, getOrCreate, e2ee);
        }
    }
}
