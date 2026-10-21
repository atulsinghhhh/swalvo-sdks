package com.swalvo.server.model;

import java.util.List;
import java.util.Map;

/** A registered host of a stream. */
public record LiveStreamHostView(
        String identity,
        LiveStreamHostRole role,
        String invitedAt) {
}
