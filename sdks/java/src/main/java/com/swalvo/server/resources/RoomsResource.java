package com.swalvo.server.resources;

import com.swalvo.server.internal.HttpCore;
import com.swalvo.server.model.CreateRoomParams;
import com.swalvo.server.model.Room;
import java.util.List;

/**
 * Rooms are control-plane records, not persistent infrastructure. {@link #delete(String)} soft-closes a room
 * (status CLOSED) rather than destroying history.
 */
public final class RoomsResource {
    private final HttpCore http;
    private final RoomParticipantsResource participants;

    public RoomsResource(HttpCore http) {
        this.http = http;
        this.participants = new RoomParticipantsResource(http);
    }

    /** Live participants, as the SFU currently sees them. */
    public RoomParticipantsResource participants() {
        return participants;
    }

    /** {@code GET /v1/rooms}. */
    public List<Room> list() {
        return http.get("/v1/rooms", null, HttpCore.listOf(Room.class));
    }

    /** {@code GET /v1/rooms/:roomId}. */
    public Room get(String roomId) {
        return http.get("/v1/rooms/" + HttpCore.segment(roomId), null, HttpCore.type(Room.class));
    }

    /**
     * {@code POST /v1/rooms}. Pass {@code getOrCreate(true)} when several participants may create the same
     * room at once, so the loser of that race gets the winner's room instead of a 409.
     */
    public Room create(CreateRoomParams params) {
        return http.send("POST", "/v1/rooms", params, HttpCore.type(Room.class));
    }

    /** Shorthand for {@code create(CreateRoomParams.builder().name(name).build())}. */
    public Room create(String name) {
        return create(CreateRoomParams.builder().name(name).build());
    }

    /** {@code DELETE /v1/rooms/:roomId}: soft-closes the room, setting status to CLOSED. Never a hard delete. */
    public void delete(String roomId) {
        http.send("DELETE", "/v1/rooms/" + HttpCore.segment(roomId), null, null);
    }
}
