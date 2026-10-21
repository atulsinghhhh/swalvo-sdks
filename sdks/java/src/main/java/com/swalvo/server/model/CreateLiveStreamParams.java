package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/**
 * Parameters for {@code liveStreams().create()}.
 *
 * @param hostIdentity registered as this stream's HOST, the only identity a stream is created with.
 * @param thumbnailUrl a URL you host. Swalvo neither accepts nor stores thumbnail uploads.
 * @param scheduledAt ISO 8601. Swalvo won't auto-transition at this time; call {@code start()} yourself.
 * @param deliveryMode {@code RTC_ONLY} (default): viewers join over WebRTC. {@code BROADCAST}: viewers watch the
 *     HLS playback URL and never join the room.
 * @param edgeScaling cascade the real-time audience across edge rooms on other media nodes, so one stream isn't
 *     capped by one node. Cascaded viewers' credentials name a different {@code rtcRoom}.
 */
public record CreateLiveStreamParams(
        String title,
        String hostIdentity,
        String description,
        String thumbnailUrl,
        String category,
        List<String> tags,
        String language,
        LiveStreamVisibility visibility,
        Map<String, Object> metadata,
        String scheduledAt,
        DeliveryMode deliveryMode,
        Boolean edgeScaling) {

    public CreateLiveStreamParams {
        Copies.required(title, "title");
        Copies.required(hostIdentity, "hostIdentity");
        tags = Copies.list(tags);
        metadata = Copies.map(metadata);
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String title;
        private String hostIdentity;
        private String description;
        private String thumbnailUrl;
        private String category;
        private List<String> tags;
        private String language;
        private LiveStreamVisibility visibility;
        private Map<String, Object> metadata;
        private String scheduledAt;
        private DeliveryMode deliveryMode;
        private Boolean edgeScaling;

        private Builder() {}

        public Builder title(String title) { this.title = title; return this; }
        public Builder hostIdentity(String identity) { this.hostIdentity = identity; return this; }
        public Builder description(String description) { this.description = description; return this; }
        public Builder thumbnailUrl(String url) { this.thumbnailUrl = url; return this; }
        public Builder category(String category) { this.category = category; return this; }
        public Builder tags(List<String> tags) { this.tags = tags; return this; }
        public Builder tags(String... tags) { this.tags = List.of(tags); return this; }
        public Builder language(String language) { this.language = language; return this; }
        public Builder visibility(LiveStreamVisibility visibility) { this.visibility = visibility; return this; }
        public Builder metadata(Map<String, Object> metadata) { this.metadata = metadata; return this; }
        public Builder scheduledAt(String isoTimestamp) { this.scheduledAt = isoTimestamp; return this; }
        public Builder deliveryMode(DeliveryMode mode) { this.deliveryMode = mode; return this; }
        public Builder edgeScaling(boolean value) { this.edgeScaling = value; return this; }

        public CreateLiveStreamParams build() {
            return new CreateLiveStreamParams(title, hostIdentity, description, thumbnailUrl, category, tags, language,
                    visibility, metadata, scheduledAt, deliveryMode, edgeScaling);
        }
    }
}
