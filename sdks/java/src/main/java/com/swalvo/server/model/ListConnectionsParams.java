package com.swalvo.server.model;

/** Typed filters for {@code connections().list()}. Every field is optional. */
public record ListConnectionsParams(String roomId, ConnectionSummaryState state, Integer limit) {

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String roomId;
        private ConnectionSummaryState state;
        private Integer limit;

        private Builder() {}

        public Builder roomId(String roomId) { this.roomId = roomId; return this; }
        public Builder state(ConnectionSummaryState state) { this.state = state; return this; }
        public Builder limit(Integer limit) { this.limit = limit; return this; }

        public ListConnectionsParams build() {
            return new ListConnectionsParams(roomId, state, limit);
        }
    }
}
