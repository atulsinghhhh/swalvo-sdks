package com.swalvo.server.model;

/** Filters for {@code liveStreams().list()}. */
public record ListLiveStreamsParams(LiveStreamStatus status) {

    public static ListLiveStreamsParams withStatus(LiveStreamStatus status) {
        return new ListLiveStreamsParams(status);
    }
}
