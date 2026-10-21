package com.swalvo.server.model;

/**
 * Parameters for {@code rooms().participants().updatePermissions()}. Only the fields you set are sent, a
 * {@code false} included; an unset field is left as it is on the live session. At least one is required;
 * {@link Builder#build()} throws {@link IllegalArgumentException} when none is set, so nothing is sent.
 *
 * @param subscribe losing it drops every track the participant is receiving.
 * @param publish turning it on with neither {@code publishAudio} nor {@code publishVideo} named, for a
 *     participant who has neither, allows both.
 * @param publishAudio has no effect without {@code publish}.
 * @param publishVideo has no effect without {@code publish}.
 * @param publishScreen screen-share. Has no effect without {@code publish}, independent of {@code publishVideo}.
 * @param publishData data-channel messages.
 */
public record UpdateParticipantPermissionsParams(
        Boolean subscribe,
        Boolean publish,
        Boolean publishAudio,
        Boolean publishVideo,
        Boolean publishScreen,
        Boolean publishData) {

    public UpdateParticipantPermissionsParams {
        if (subscribe == null && publish == null && publishAudio == null && publishVideo == null
                && publishScreen == null && publishData == null) {
            throw new IllegalArgumentException("at least one permission is required");
        }
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private Boolean subscribe;
        private Boolean publish;
        private Boolean publishAudio;
        private Boolean publishVideo;
        private Boolean publishScreen;
        private Boolean publishData;

        private Builder() {}

        public Builder subscribe(boolean value) { this.subscribe = value; return this; }
        public Builder publish(boolean value) { this.publish = value; return this; }
        public Builder publishAudio(boolean value) { this.publishAudio = value; return this; }
        public Builder publishVideo(boolean value) { this.publishVideo = value; return this; }
        public Builder publishScreen(boolean value) { this.publishScreen = value; return this; }
        public Builder publishData(boolean value) { this.publishData = value; return this; }

        public UpdateParticipantPermissionsParams build() {
            return new UpdateParticipantPermissionsParams(
                    subscribe, publish, publishAudio, publishVideo, publishScreen, publishData);
        }
    }
}
