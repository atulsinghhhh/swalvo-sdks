package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** {@link IngressView} plus the full stream key ({@code sk_...}). Returned only by {@code create()} and {@code reset()}: store it then. */
public record IngressWithKey(
        String id,
        IngressProtocol protocol,
        String identity,
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
        String updatedAt,
        /** The RTMP stream key and WHIP bearer token. A secret: excluded from {@link #toString()}. */
        String streamKey) {

    /** This ingest without its stream key. */
    public IngressView view() {
        return new IngressView(id, protocol, identity, keyPrefix, autoStart, status, reconnectWindowSec, lastError,
                inputVideo, inputAudio, whipUrl, rtmpUrl, rtmpsUrl, connectedAt, disconnectedAt, createdAt, updatedAt);
    }

    /** Leaves the stream key out, so the object is safe to log. */
    @Override
    public String toString() {
        return "IngressWithKey[" + view() + ", streamKey=[REDACTED]]";
    }
}
