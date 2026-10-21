package com.swalvo.server.model;

/**
 * Options for {@code liveStreams().createViewerToken()}.
 *
 * @param acceptPlayback set when your client can play HLS: a BROADCAST stream then returns a playback
 *     credential (chat plus {@code playback.url}) instead of a 409, so one call serves every delivery mode.
 */
public record ViewerTokenOptions(boolean acceptPlayback) {

    /** No options: an RTC viewer token, or a 409 for a BROADCAST stream. */
    public static final ViewerTokenOptions DEFAULT = new ViewerTokenOptions(false);

    /** Accept an HLS playback credential for a BROADCAST stream. */
    public static ViewerTokenOptions acceptingPlayback() {
        return new ViewerTokenOptions(true);
    }
}
