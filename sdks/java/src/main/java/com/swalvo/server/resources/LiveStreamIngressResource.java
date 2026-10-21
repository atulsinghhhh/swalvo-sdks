package com.swalvo.server.resources;

import com.swalvo.server.internal.HttpCore;
import com.swalvo.server.model.CreateIngressParams;
import com.swalvo.server.model.IngressView;
import com.swalvo.server.model.IngressWithKey;

/**
 * Ingest: broadcast into a stream from OBS, vMix, ffmpeg or a hardware encoder. One ingest per stream. The
 * encoder joins the stream's room as an ordinary host, so RTC viewers, HLS and restreams all see it.
 *
 * <p>The stream key ({@code sk_...}) is the RTMP stream key and the WHIP bearer token. It's stored only as a
 * hash and returned only by {@link #create} and {@link #reset}.
 */
public final class LiveStreamIngressResource {
    private final HttpCore http;

    public LiveStreamIngressResource(HttpCore http) {
        this.http = http;
    }

    /** {@code POST /v1/live-streams/:streamId/ingress}. The key in the response is shown this once. */
    public IngressWithKey create(String streamId, CreateIngressParams params) {
        return http.send("POST", base(streamId), params != null ? params : CreateIngressParams.DEFAULTS,
                HttpCore.type(IngressWithKey.class));
    }

    /** As {@link #create(String, CreateIngressParams)} with every API default; sends {@code {}}. */
    public IngressWithKey create(String streamId) {
        return create(streamId, CreateIngressParams.DEFAULTS);
    }

    /** {@code GET /v1/live-streams/:streamId/ingress}: status and observed input. Never the stream key. */
    public IngressView get(String streamId) {
        return http.get(base(streamId), null, HttpCore.type(IngressView.class));
    }

    /** {@code POST /v1/live-streams/:streamId/ingress/reset}: rotates the key and disconnects the encoder. */
    public IngressWithKey reset(String streamId) {
        return http.send("POST", base(streamId) + "/reset", null, HttpCore.type(IngressWithKey.class));
    }

    /** {@code DELETE /v1/live-streams/:streamId/ingress}. The stream itself keeps running. */
    public void delete(String streamId) {
        http.send("DELETE", base(streamId), null, null);
    }

    private static String base(String streamId) {
        return LiveStreamsResource.path(streamId) + "/ingress";
    }
}
