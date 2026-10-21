package com.swalvo.server.resources;

import com.swalvo.server.internal.Bodies;
import com.swalvo.server.internal.HttpCore;
import com.swalvo.server.model.LiveParticipantInfo;
import com.swalvo.server.model.MuteParticipantParams;
import com.swalvo.server.model.ParticipantPermissions;
import com.swalvo.server.model.UpdateParticipantPermissionsParams;
import java.util.List;
import java.util.Optional;

/**
 * Always the SFU's current live state, never a stored roster.
 *
 * <p>An empty {@link Optional} from {@link #list(String)} means the SFU couldn't be reached. That's a
 * different thing from a genuinely empty room (an empty list), and the two are never collapsed.
 *
 * <p>{@link #remove}, {@link #mute} and {@link #updatePermissions} moderate a participant who is connected
 * right now. {@code roomId} may be the room's id or its name. A participant who isn't connected is a 404
 * with code {@code RAVEN_PARTICIPANT_NOT_CONNECTED}.
 */
public final class RoomParticipantsResource {
    private final HttpCore http;

    public RoomParticipantsResource(HttpCore http) {
        this.http = http;
    }

    /** {@code GET /v1/rooms/:roomId/participants}. Empty when the SFU was unreachable (the API sent null). */
    public Optional<List<LiveParticipantInfo>> list(String roomId) {
        List<LiveParticipantInfo> participants = http.get(
                "/v1/rooms/" + HttpCore.segment(roomId) + "/participants", null,
                HttpCore.listOf(LiveParticipantInfo.class));
        return Optional.ofNullable(participants);
    }

    /** One live participant by identity. Empty when absent or when the SFU was unreachable. */
    public Optional<LiveParticipantInfo> get(String roomId, String identity) {
        return list(roomId).flatMap(participants -> participants.stream()
                .filter(p -> identity.equals(p.identity()))
                .findFirst());
    }

    /**
     * {@code POST /v1/rooms/:roomId/participants/:identity/remove}. Disconnects every live session of the
     * identity. Doesn't revoke their token: revoke it too to keep them out.
     *
     * @throws com.swalvo.server.SwalvoException {@code RAVEN_PARTICIPANT_NOT_CONNECTED} (404) when they
     *     aren't connected
     */
    public void remove(String roomId, String identity) {
        http.send("POST", path(roomId, identity) + "/remove", Bodies.of(), null);
    }

    /**
     * {@code POST /v1/rooms/:roomId/participants/:identity/mute}. Mutes, or unmutes, one track or every track
     * of one kind.
     *
     * @throws com.swalvo.server.SwalvoException {@code RAVEN_PARTICIPANT_NOT_CONNECTED} or
     *     {@code RAVEN_TRACK_NOT_FOUND} (404)
     */
    public void mute(String roomId, String identity, MuteParticipantParams params) {
        http.send("POST", path(roomId, identity) + "/mute", params, null);
    }

    /**
     * {@code PATCH /v1/rooms/:roomId/participants/:identity/permissions}. Merges into the live session's
     * permissions and returns the result. Issued tokens are not changed.
     *
     * @throws com.swalvo.server.SwalvoException {@code RAVEN_PARTICIPANT_NOT_CONNECTED} (404) when they
     *     aren't connected
     */
    public ParticipantPermissions updatePermissions(
            String roomId, String identity, UpdateParticipantPermissionsParams params) {
        return http.send("PATCH", path(roomId, identity) + "/permissions", params,
                HttpCore.type(ParticipantPermissions.class));
    }

    private static String path(String roomId, String identity) {
        return "/v1/rooms/" + HttpCore.segment(roomId) + "/participants/" + HttpCore.segment(identity);
    }
}
