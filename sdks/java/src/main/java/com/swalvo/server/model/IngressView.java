package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** A stream's ingest endpoint for OBS, vMix, ffmpeg or a hardware encoder. Never includes the stream key. */
public record IngressView(
        /** {@code ing_...} */
        String id,
        IngressProtocol protocol,
        /** The host identity the encoder publishes as. */
        String identity,
        /** The first characters of the stream key, for display. */
        String keyPrefix,
        boolean autoStart,
        IngressStatus status,
        int reconnectWindowSec,
        String lastError,
        IngressInputVideo inputVideo,
        IngressInputAudio inputAudio,
        String whipUrl,
        String rtmpUrl,
        String rtmpsUrl,
        String connectedAt,
        String disconnectedAt,
        String createdAt,
        String updatedAt) {
}
