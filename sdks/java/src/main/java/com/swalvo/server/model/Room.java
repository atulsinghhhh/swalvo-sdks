package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** A room: a control-plane record, not persistent infrastructure. */
public record Room(
        String id,
        String projectId,
        String name,
        RoomStatus status,
        /** End-to-end encrypted media. Fixed at create. Null when the API didn't say. */
        Boolean e2ee,
        String createdAt,
        String updatedAt) {
}
