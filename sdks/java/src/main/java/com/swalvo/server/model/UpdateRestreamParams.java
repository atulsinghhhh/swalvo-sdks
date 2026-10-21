package com.swalvo.server.model;

/**
 * Parameters for {@code liveStreams().restreams().update()}.
 *
 * @param enabled {@code false} pauses this destination mid-stream without deleting it; {@code true} resumes.
 */
public record UpdateRestreamParams(Boolean enabled, String label) {

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private Boolean enabled;
        private String label;

        private Builder() {}

        public Builder enabled(boolean enabled) { this.enabled = enabled; return this; }
        public Builder label(String label) { this.label = label; return this; }

        public UpdateRestreamParams build() {
            return new UpdateRestreamParams(enabled, label);
        }
    }
}
