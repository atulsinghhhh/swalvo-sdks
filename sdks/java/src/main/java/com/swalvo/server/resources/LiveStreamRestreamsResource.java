package com.swalvo.server.resources;

import com.swalvo.server.internal.HttpCore;
import com.swalvo.server.model.CreateRestreamParams;
import com.swalvo.server.model.RestreamView;
import com.swalvo.server.model.UpdateRestreamParams;
import java.util.List;

/**
 * Restream ("RTMP out"): push a live stream to up to 5 RTMP/RTMPS destinations at once, alongside RTC
 * viewers and HLS. Destinations can be added, paused and removed while the stream is LIVE; one failing never
 * affects the others.
 *
 * <p>The destination's stream key is encrypted at rest and never returned: {@code keyLast4} is all you get
 * back. To change a key, delete the destination and create it again.
 */
public final class LiveStreamRestreamsResource {
    private final HttpCore http;

    public LiveStreamRestreamsResource(HttpCore http) {
        this.http = http;
    }

    /** {@code POST /v1/live-streams/:streamId/restreams}. If the stream is LIVE, pushing starts immediately. */
    public RestreamView create(String streamId, CreateRestreamParams params) {
        return http.send("POST", base(streamId), params, HttpCore.type(RestreamView.class));
    }

    /** {@code GET /v1/live-streams/:streamId/restreams}. */
    public List<RestreamView> list(String streamId) {
        return http.get(base(streamId), null, HttpCore.listOf(RestreamView.class));
    }

    /** {@code PATCH /v1/live-streams/:streamId/restreams/:restreamId}: {@code enabled(false)} pauses one destination. */
    public RestreamView update(String streamId, String restreamId, UpdateRestreamParams params) {
        return http.send("PATCH", base(streamId) + "/" + HttpCore.segment(restreamId), params,
                HttpCore.type(RestreamView.class));
    }

    /** {@code DELETE /v1/live-streams/:streamId/restreams/:restreamId}: stops pushing and removes it. */
    public void delete(String streamId, String restreamId) {
        http.send("DELETE", base(streamId) + "/" + HttpCore.segment(restreamId), null, null);
    }

    private static String base(String streamId) {
        return LiveStreamsResource.path(streamId) + "/restreams";
    }
}
