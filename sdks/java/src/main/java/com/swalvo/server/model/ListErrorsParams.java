package com.swalvo.server.model;

/** Typed filters for {@code errors().list()}. Every field is optional. */
public record ListErrorsParams(ErrorCategory category, String connectionId, Integer limit) {

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private ErrorCategory category;
        private String connectionId;
        private Integer limit;

        private Builder() {}

        public Builder category(ErrorCategory category) { this.category = category; return this; }
        public Builder connectionId(String connectionId) { this.connectionId = connectionId; return this; }
        public Builder limit(Integer limit) { this.limit = limit; return this; }

        public ListErrorsParams build() {
            return new ListErrorsParams(category, connectionId, limit);
        }
    }
}
