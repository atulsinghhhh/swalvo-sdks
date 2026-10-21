package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** A participant as the SFU currently sees them. Never a stored roster. */
public record LiveParticipantInfo(
        String identity,
        String joinedAt,
        List<LiveTrackInfo> tracks) {
}
