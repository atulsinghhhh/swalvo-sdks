package com.swalvo.server.model;

/**
 * Swalvo's own permission vocabulary for an RTC token. Unset fields are left out of the request, so the
 * API's defaults apply.
 */
public record TokenPermissions(
        Boolean join,
        Boolean subscribe,
        Boolean publish,
        Boolean publishAudio,
        Boolean publishVideo,
        Boolean publishScreen,
        Boolean publishData) {

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private Boolean join;
        private Boolean subscribe;
        private Boolean publish;
        private Boolean publishAudio;
        private Boolean publishVideo;
        private Boolean publishScreen;
        private Boolean publishData;

        private Builder() {}

        public Builder join(boolean value) { this.join = value; return this; }
        public Builder subscribe(boolean value) { this.subscribe = value; return this; }
        public Builder publish(boolean value) { this.publish = value; return this; }
        public Builder publishAudio(boolean value) { this.publishAudio = value; return this; }
        public Builder publishVideo(boolean value) { this.publishVideo = value; return this; }
        /** Screen-share, independent of publishVideo (agora-parity audit, phase 2). */
        public Builder publishScreen(boolean value) { this.publishScreen = value; return this; }
        public Builder publishData(boolean value) { this.publishData = value; return this; }

        public TokenPermissions build() {
            return new TokenPermissions(join, subscribe, publish, publishAudio, publishVideo, publishScreen, publishData);
        }
    }
}
