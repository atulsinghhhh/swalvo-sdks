package com.swalvo.server.model;

/**
 * Parameters for {@code rooms().participants().mute()}. Exactly one of {@code trackId} and {@code kind} is
 * required; {@link Builder#build()} throws {@link IllegalArgumentException} for both or neither, so nothing
 * is sent.
 *
 * @param trackId mute exactly this track (a {@link LiveTrackInfo#sid()}).
 * @param kind mute every track of this kind the participant is publishing: {@link TrackKind#AUDIO} or
 *     {@link TrackKind#VIDEO}.
 * @param muted {@code true} mutes, {@code false} unmutes. Required.
 */
public record MuteParticipantParams(String trackId, TrackKind kind, Boolean muted) {

    public MuteParticipantParams {
        if ((trackId == null) == (kind == null)) {
            throw new IllegalArgumentException("exactly one of trackId or kind is required");
        }
        if (kind != null && kind != TrackKind.AUDIO && kind != TrackKind.VIDEO) {
            throw new IllegalArgumentException("kind must be AUDIO or VIDEO");
        }
        Copies.required(muted, "muted");
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String trackId;
        private TrackKind kind;
        private Boolean muted;

        private Builder() {}

        public Builder trackId(String trackId) { this.trackId = trackId; return this; }
        public Builder kind(TrackKind kind) { this.kind = kind; return this; }
        public Builder muted(boolean muted) { this.muted = muted; return this; }

        public MuteParticipantParams build() {
            return new MuteParticipantParams(trackId, kind, muted);
        }
    }
}
