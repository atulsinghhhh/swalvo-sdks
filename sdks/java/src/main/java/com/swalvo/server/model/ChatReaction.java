package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** An aggregated reaction on a message. */
public record ChatReaction(
        String emoji,
        int count,
        List<String> userIds) {
}
