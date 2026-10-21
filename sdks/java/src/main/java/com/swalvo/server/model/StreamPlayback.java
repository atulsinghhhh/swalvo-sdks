package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** A BROADCAST viewer's HLS playback. {@code url} may 404 briefly while the stream starts. */
public record StreamPlayback(
        String url,
        /** Low-latency HLS when the worker serves it; players prefer it and fall back to {@code url}. */
        String llhlsUrl,
        LiveStreamDeliveryStatus status,
        /** Watch-time heartbeat for viewer-minute billing; forward the credential to the client untouched. */
        PlaybackBeacon beacon) {

    /** Where an SDK player reports watch time while playing. */
    public record PlaybackBeacon(String url, String token, int intervalSec) {
    }
}
