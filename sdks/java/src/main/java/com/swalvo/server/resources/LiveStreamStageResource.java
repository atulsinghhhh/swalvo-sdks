package com.swalvo.server.resources;

import com.swalvo.server.internal.Bodies;
import com.swalvo.server.internal.HttpCore;
import com.swalvo.server.model.IssuedStreamCredential;
import com.swalvo.server.model.LiveStreamHostRole;

/**
 * The stage (Agora's setClientRole). Invite announces it to the viewer's client; promote registers them as a
 * co-host and returns host credentials, which their client passes to {@code LiveStream.switchRole()}; demote
 * takes a co-host off stage and stops their publishing at once.
 */
public final class LiveStreamStageResource {
    private final HttpCore http;

    public LiveStreamStageResource(HttpCore http) {
        this.http = http;
    }

    /** {@code POST /v1/live-streams/:streamId/stage/invites}. Changes no permissions. */
    public void invite(String streamId, String identity) {
        http.send("POST", LiveStreamsResource.path(streamId) + "/stage/invites", Bodies.of("identity", identity), null);
    }

    /** {@code POST /v1/live-streams/:streamId/stage/promote}, as the API's default role (CO_HOST). */
    public IssuedStreamCredential promote(String streamId, String identity) {
        return promote(streamId, identity, null);
    }

    /** {@code POST /v1/live-streams/:streamId/stage/promote}. A null role is left out of the body. */
    public IssuedStreamCredential promote(String streamId, String identity, LiveStreamHostRole role) {
        return http.send("POST", LiveStreamsResource.path(streamId) + "/stage/promote",
                Bodies.of("identity", identity, "role", role), HttpCore.type(IssuedStreamCredential.class));
    }

    /** {@code POST /v1/live-streams/:streamId/stage/demote}. */
    public void demote(String streamId, String identity) {
        http.send("POST", LiveStreamsResource.path(streamId) + "/stage/demote", Bodies.of("identity", identity), null);
    }
}
