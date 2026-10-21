package com.swalvo.server.resources;

import com.swalvo.server.internal.Bodies;
import com.swalvo.server.internal.HttpCore;
import com.swalvo.server.model.AddHostParams;
import com.swalvo.server.model.CreateLiveStreamParams;
import com.swalvo.server.model.IssuedStreamCredential;
import com.swalvo.server.model.ListLiveStreamsParams;
import com.swalvo.server.model.LiveStream;
import com.swalvo.server.model.LiveStreamDelivery;
import com.swalvo.server.model.UpdateLiveStreamParams;
import com.swalvo.server.model.ViewerTokenOptions;
import java.util.List;

/**
 * Swalvo Live Streaming, server-side. A stream composes an RTC room and a chat conversation; this resource
 * owns lifecycle and role bookkeeping on top of those.
 *
 * <p>{@link #addHost} and {@link #createViewerToken} are the security-critical pair. The role your caller
 * ends up with is decided entirely by which method you call, never by a field in the request body. A viewer
 * token is always subscribe-only. {@code addHost}, called from your own backend after your own auth check, is
 * the only route to publish access.
 */
public final class LiveStreamsResource {
    private final HttpCore http;
    private final LiveStreamStageResource stage;
    private final LiveStreamRestreamsResource restreams;
    private final LiveStreamIngressResource ingress;

    public LiveStreamsResource(HttpCore http) {
        this.http = http;
        this.stage = new LiveStreamStageResource(http);
        this.restreams = new LiveStreamRestreamsResource(http);
        this.ingress = new LiveStreamIngressResource(http);
    }

    /** The stage: invite, promote and demote viewers. */
    public LiveStreamStageResource stage() {
        return stage;
    }

    /** RTMP/RTMPS destinations (YouTube, Twitch, ...) a stream is pushed to. */
    public LiveStreamRestreamsResource restreams() {
        return restreams;
    }

    /** The stream's ingest endpoint for OBS and other encoders, over WHIP or RTMP/RTMPS. */
    public LiveStreamIngressResource ingress() {
        return ingress;
    }

    /** {@code POST /v1/live-streams}. */
    public LiveStream create(CreateLiveStreamParams params) {
        return http.send("POST", "/v1/live-streams", params, HttpCore.type(LiveStream.class));
    }

    /** {@code GET /v1/live-streams?status=}. */
    public List<LiveStream> list(ListLiveStreamsParams params) {
        return http.get("/v1/live-streams",
                Bodies.of("status", params == null ? null : params.status()),
                HttpCore.listOf(LiveStream.class));
    }

    public List<LiveStream> list() {
        return list(null);
    }

    /** {@code GET /v1/live-streams/:streamId}. Includes the live viewer count, which {@code list()} doesn't. */
    public LiveStream get(String streamId) {
        return http.get(path(streamId), null, HttpCore.type(LiveStream.class));
    }

    /** {@code PATCH /v1/live-streams/:streamId}. */
    public LiveStream update(String streamId, UpdateLiveStreamParams params) {
        return http.send("PATCH", path(streamId), params, HttpCore.type(LiveStream.class));
    }

    /** {@code POST /v1/live-streams/:streamId/start}: CREATED to LIVE. */
    public LiveStream start(String streamId) {
        return http.send("POST", path(streamId) + "/start", null, HttpCore.type(LiveStream.class));
    }

    /** {@code POST /v1/live-streams/:streamId/end}: LIVE to ENDED, which is terminal. */
    public LiveStream end(String streamId) {
        return http.send("POST", path(streamId) + "/end", null, HttpCore.type(LiveStream.class));
    }

    /**
     * {@code POST /v1/live-streams/:streamId/hosts}: registers a host or co-host and mints full-publish RTC
     * plus moderator-or-above chat credentials in one call. Call it again to re-mint fresh ones.
     */
    public IssuedStreamCredential addHost(String streamId, AddHostParams params) {
        return http.send("POST", path(streamId) + "/hosts", params, HttpCore.type(IssuedStreamCredential.class));
    }

    /** {@code DELETE /v1/live-streams/:streamId/hosts/:identity}: a soft removal; chat history survives. */
    public void removeHost(String streamId, String identity) {
        http.send("DELETE", path(streamId) + "/hosts/" + HttpCore.segment(identity), null, null);
    }

    /** {@code POST /v1/live-streams/:streamId/viewer-tokens}: always subscribe-only on RTC and MEMBER on chat. */
    public IssuedStreamCredential createViewerToken(String streamId, String identity) {
        return createViewerToken(streamId, identity, ViewerTokenOptions.DEFAULT);
    }

    /**
     * As {@link #createViewerToken(String, String)}. With {@code acceptPlayback}, a BROADCAST stream returns a
     * playback credential (chat plus {@code playback}) instead of a 409. {@code acceptPlayback} is only sent
     * when true.
     */
    public IssuedStreamCredential createViewerToken(String streamId, String identity, ViewerTokenOptions options) {
        boolean acceptPlayback = options != null && options.acceptPlayback();
        return http.send("POST", path(streamId) + "/viewer-tokens",
                Bodies.of("identity", identity, "acceptPlayback", acceptPlayback ? Boolean.TRUE : null),
                HttpCore.type(IssuedStreamCredential.class));
    }

    /**
     * {@code GET /v1/live-streams/:streamId/playback}: the stream's delivery view, including the HLS
     * {@code playbackUrl} and low-latency {@code llhlsPlaybackUrl}. Works for RTC_ONLY streams too (status
     * {@code NOT_APPLICABLE}).
     */
    public LiveStreamDelivery getPlayback(String streamId) {
        return http.get(path(streamId) + "/playback", null, HttpCore.type(LiveStreamDelivery.class));
    }

    /**
     * {@code POST /v1/live-streams/:streamId/leave}: a clean-leave signal for {@code live_stream.viewer_left}.
     * Not a disconnect detector; call it when your own app knows a viewer left.
     */
    public void leave(String streamId, String identity) {
        http.send("POST", path(streamId) + "/leave", Bodies.of("identity", identity), null);
    }

    static String path(String streamId) {
        return "/v1/live-streams/" + HttpCore.segment(streamId);
    }
}
