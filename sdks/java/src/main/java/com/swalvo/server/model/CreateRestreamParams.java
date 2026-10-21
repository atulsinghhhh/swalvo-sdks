package com.swalvo.server.model;

/**
 * Parameters for {@code liveStreams().restreams().create()}.
 *
 * @param url {@code rtmp://} or {@code rtmps://} only, without the key. Private/loopback hosts are rejected.
 * @param streamKey the destination's stream key. Write-only: encrypted at rest, never returned, and excluded
 *     from {@link #toString()}.
 */
public record CreateRestreamParams(String url, String streamKey, String label) {

    public CreateRestreamParams {
        Copies.required(url, "url");
        Copies.required(streamKey, "streamKey");
    }

    public static CreateRestreamParams of(String url, String streamKey) {
        return new CreateRestreamParams(url, streamKey, null);
    }

    public static CreateRestreamParams of(String url, String streamKey, String label) {
        return new CreateRestreamParams(url, streamKey, label);
    }

    /** Leaves the stream key out, so the object is safe to log. */
    @Override
    public String toString() {
        return "CreateRestreamParams[url=" + url + ", streamKey=[REDACTED], label=" + label + "]";
    }
}
