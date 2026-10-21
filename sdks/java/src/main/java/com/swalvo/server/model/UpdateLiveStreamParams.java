package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/**
 * Everything about a stream you might change before or during it. Never its status: {@code start()} and
 * {@code end()} handle that. Unset fields are left out of the PATCH.
 */
public record UpdateLiveStreamParams(
        String title,
        String description,
        String thumbnailUrl,
        String category,
        List<String> tags,
        String language,
        LiveStreamVisibility visibility,
        Map<String, Object> metadata) {

    public UpdateLiveStreamParams {
        tags = Copies.list(tags);
        metadata = Copies.map(metadata);
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String title;
        private String description;
        private String thumbnailUrl;
        private String category;
        private List<String> tags;
        private String language;
        private LiveStreamVisibility visibility;
        private Map<String, Object> metadata;

        private Builder() {}

        public Builder title(String title) { this.title = title; return this; }
        public Builder description(String description) { this.description = description; return this; }
        public Builder thumbnailUrl(String url) { this.thumbnailUrl = url; return this; }
        public Builder category(String category) { this.category = category; return this; }
        public Builder tags(List<String> tags) { this.tags = tags; return this; }
        public Builder tags(String... tags) { this.tags = List.of(tags); return this; }
        public Builder language(String language) { this.language = language; return this; }
        public Builder visibility(LiveStreamVisibility visibility) { this.visibility = visibility; return this; }
        public Builder metadata(Map<String, Object> metadata) { this.metadata = metadata; return this; }

        public UpdateLiveStreamParams build() {
            return new UpdateLiveStreamParams(title, description, thumbnailUrl, category, tags, language, visibility,
                    metadata);
        }
    }
}
