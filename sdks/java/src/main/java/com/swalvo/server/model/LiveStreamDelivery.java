package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** A stream's audience delivery: the HLS path for BROADCAST streams. Never storage credentials or worker URLs. */
public record LiveStreamDelivery(
        DeliveryMode mode,
        LiveStreamDeliveryStatus status,
        /** Set once egress reports a fetchable manifest. */
        String playbackUrl,
        /** Low-latency HLS (about 2 s), when the worker serves it. Prefer it; fall back to {@code playbackUrl}. */
        String llhlsPlaybackUrl,
        /** Set once the stream has ended, when HLS ran: a VOD playlist of the whole broadcast. */
        String recordingUrl,
        Integer recordingDurationSec) {
}
